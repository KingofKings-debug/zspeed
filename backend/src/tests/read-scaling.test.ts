import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as pool from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { seedDatabase } from '../db/seed.js';
import { openReadStore,closeReadStores,replicaSnapshot,readStorePath } from '../db/read-store.js';
import { refreshReadModels,replicateReadModels,saveSnapshot,bootstrapReadModels } from '../services/read-model.service.js';
import { cachedRead,setCacheAdapterForTests,bounded } from '../services/read-cache.service.js';
import { workerBudget } from '../services/background-scheduler.js';
import { claimNextJob,executeClaimedJob } from '../services/worker.service.js';
import { enqueueProjectionRebuild } from '../services/projection.service.js';
import { ingestEvent,processRawEvent,replayEvents,runReplayJob } from '../services/ingestion.service.js';
import { app } from '../index.js';

let directory:string;
const fleet='fleet_scaling', car='vehicle_scaling', trip='trip_scaling';
const auth=`Bearer demo:${fleet}:fleet_manager`;
function fixtureTrip(id=trip,number=1) {
  pool.run(`INSERT INTO trips(id,vehicle_id,fleet_id,trip_number,started_at,ended_at,distance_km,duration_seconds)
    VALUES(?,?,?,?,?,?,12,3600)`,[id,car,fleet,number,`2026-09-${String(Math.min(number,28)).padStart(2,'0')}T10:00:00Z`,`2026-09-${String(Math.min(number,28)).padStart(2,'0')}T11:00:00Z`]);
}
function settle() { while(refreshReadModels(100,0)) {} replicateReadModels(10000); }
beforeEach(()=>{
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'zspeed-read-test-'));
  process.env.OVERRIDE_DB_PATH=path.join(directory,'source.db');
  runMigrations(); seedDatabase();
  pool.run('INSERT INTO fleets(id,name) VALUES(?,?)',[fleet,'Read fleet']);
  pool.run('INSERT INTO vehicles(id,fleet_id,vin,label) VALUES(?,?,?,?)',[car,fleet,'VIN-READ','Read vehicle']);
  pool.run('INSERT INTO oem_connections(id,fleet_id,oem_id,label,status) VALUES(?,?,?, ?,?)',['conn_read',fleet,'oem_voltera','Read connection','ACTIVE']);
  pool.run('INSERT INTO vehicle_source_mappings(id,vehicle_id,connection_id,oem_vehicle_id) VALUES(?,?,?,?)',['map_read',car,'conn_read','OEM-READ']);
});
afterEach(()=>{
  vi.restoreAllMocks();setCacheAdapterForTests(null);closeReadStores();pool.closeDb();delete process.env.OVERRIDE_DB_PATH;
  fs.rmSync(directory,{recursive:true,force:true});
});

describe('read models and replica',()=>{
  it('recreates lost derived databases from retained operational data',()=>{
    fixtureTrip();settle();closeReadStores();
    for(const filename of fs.readdirSync(directory).filter(name=>name.includes('.reads.db')||name.includes('.replica.db'))) fs.unlinkSync(path.join(directory,filename));
    bootstrapReadModels();settle();
    expect(replicaSnapshot('vehicle',car,fleet).stats.trips).toBe(1);
    expect(replicaSnapshot('trip',trip,fleet,car).trip.id).toBe(trip);
  });
  it('repopulates a lost replica without recomputing source snapshots',()=>{
    settle();closeReadStores();
    for(const filename of fs.readdirSync(directory).filter(name=>name.includes('.replica.db'))) fs.unlinkSync(path.join(directory,filename));
    bootstrapReadModels();expect(replicateReadModels(100)).toBeGreaterThan(0);
    expect(replicaSnapshot('vehicle',car,fleet).vehicle.id).toBe(car);
  });
  it('updates health tags and trip quality after quarantine repair',()=>{
    fixtureTrip();
    const event=ingestEvent(fleet,'conn_read','OEM-READ',{bad:'format'},'quality-event');
    pool.run('UPDATE quarantine_records SET first_failure_at=? WHERE raw_event_id=?',['2026-09-01T10:30:00Z',event.eventId]);
    settle();
    expect(replicaSnapshot('vehicle',car,fleet).healthTags).toContain('DATA_QUALITY');
    expect(replicaSnapshot('trip',trip,fleet,car).quality.quarantinedEvents).toBe(1);
    pool.run("UPDATE quarantine_records SET status='REPLAY_FAILED' WHERE raw_event_id=?",[event.eventId]);settle();
    expect(replicaSnapshot('vehicle',car,fleet).dataQuality.unresolvedEvents).toBe(1);
    pool.run("UPDATE quarantine_records SET status='RESOLVED' WHERE raw_event_id=?",[event.eventId]);settle();
    expect(replicaSnapshot('vehicle',car,fleet).dataQuality.unresolvedEvents).toBe(0);
    expect(replicaSnapshot('trip',trip,fleet,car).quality.quarantinedEvents).toBe(0);
  });
  it('coalesces changes and rolls back refresh requests with the source transaction',()=>{
    const before=pool.queryOne<any>("SELECT generation FROM read_refresh_queue WHERE entity_id=?",[car]).generation;
    pool.run('UPDATE vehicles SET label=? WHERE id=?',['Updated',car]);
    pool.run('UPDATE vehicles SET label=? WHERE id=?',['Latest',car]);
    expect(pool.queryOne<any>('SELECT generation FROM read_refresh_queue WHERE entity_id=?',[car]).generation).toBe(before+2);
    expect(()=>pool.transaction(()=>{pool.run('UPDATE vehicles SET label=? WHERE id=?',['Rolled back',car]);throw new Error('Rollback');})).toThrow();
    expect(pool.queryOne<any>('SELECT generation FROM read_refresh_queue WHERE entity_id=?',[car]).generation).toBe(before+2);
  });
  it('retains newer refresh generations when an older generation is acknowledged',()=>{
    const old=pool.queryOne<any>('SELECT * FROM read_refresh_queue WHERE entity_id=?',[car]);
    pool.run('UPDATE vehicles SET label=? WHERE id=?',['Newer',car]);
    pool.run('DELETE FROM read_refresh_queue WHERE entity_id=? AND generation=?',[car,old.generation]);
    expect(pool.queryOne('SELECT 1 FROM read_refresh_queue WHERE entity_id=?',[car])).toBeDefined();
  });
  it('builds health/stat summaries in a separate database and catches up the replica',()=>{
    fixtureTrip();refreshReadModels(100,0);
    expect(readStorePath()).not.toBe(readStorePath(true));
    expect(replicaSnapshot('vehicle',car,fleet)).toBeNull();
    replicateReadModels(100);
    const value=replicaSnapshot('vehicle',car,fleet);
    expect(value.stats).toMatchObject({trips:1,distanceKm:12,durationSeconds:3600});
    expect(value.healthTags).toContain('AWAITING_DATA');
    expect(value.freshness.eventualConsistency).toBe(true);
  });
  it('serves the last completed snapshot while new data waits for replication',()=>{
    settle();pool.run('UPDATE vehicles SET label=? WHERE id=?',['New label',car]);refreshReadModels(100,0);
    expect(replicaSnapshot('vehicle',car,fleet).vehicle.label).toBe('Read vehicle');
    replicateReadModels(100);
    expect(replicaSnapshot('vehicle',car,fleet).vehicle.label).toBe('New label');
  });
  it('resumes replication after reopened connections and rejects stale revisions',()=>{
    settle();pool.run('UPDATE vehicles SET label=? WHERE id=?',['After restart',car]);refreshReadModels(100,0);
    closeReadStores();replicateReadModels(100);
    expect(replicaSnapshot('vehicle',car,fleet).vehicle.label).toBe('After restart');
    const source=openReadStore();source.prepare("UPDATE snapshots SET revision=1,replicated=0 WHERE kind='vehicle' AND entity_id=?").run(car);
    replicateReadModels(100);
    expect(replicaSnapshot('vehicle',car,fleet).vehicle.label).toBe('After restart');
  });
  it('retries failed builds without replacing a valid replica snapshot',()=>{
    fixtureTrip();settle();pool.run("UPDATE trips SET quality_notes='invalid json' WHERE id=?",[trip]);
    refreshReadModels(100,0);
    expect(pool.queryOne<any>("SELECT attempts,error,retry_at FROM read_refresh_queue WHERE kind='trip' AND entity_id=?",[trip])).toMatchObject({attempts:1});
    expect(replicaSnapshot('trip',trip,fleet,car).quality.completeness).toBe(100);
    pool.run("UPDATE trips SET quality_notes='[]' WHERE id=?",[trip]);settle();
    expect(pool.queryOne("SELECT 1 FROM read_refresh_queue WHERE kind='trip' AND entity_id=?",[trip])).toBeUndefined();
  });
  it('prevents continuously arriving events from starving a summary refresh',()=>{
    pool.run("UPDATE read_refresh_queue SET queued_at=datetime('now','-20 seconds'),changed_at=datetime('now'),generation=20 WHERE entity_id=?",[car]);
    expect(refreshReadModels(100,60)).toBeGreaterThan(0);
    expect(openReadStore().prepare("SELECT 1 FROM snapshots WHERE kind='vehicle' AND entity_id=?").get(car)).toBeDefined();
  });
  it('replicates deletion tombstones',()=>{
    settle();pool.run('DELETE FROM vehicle_source_mappings WHERE vehicle_id=?',[car]);pool.run('DELETE FROM vehicles WHERE id=?',[car]);settle();
    expect(replicaSnapshot('vehicle',car,fleet)).toBeNull();
  });
  it('returns map, important events and quality in one request without accessing the source database',async()=>{
    fixtureTrip();
    const points=[{lat:0,lon:0,eventTime:'2026-09-01T10:00:00Z'},{lat:0.01,lon:0.01,eventTime:'2026-09-01T10:01:00Z'}];
    pool.run('INSERT INTO trip_routes(id,trip_id,ordered_points,simplified_points,point_count) VALUES(?,?,?,?,2)',['route',trip,JSON.stringify(points),JSON.stringify(points)]);
    pool.run('INSERT INTO trip_events(id,trip_id,vehicle_id,event_type,event_time) VALUES(?,?,?,?,?)',['event',trip,car,'HARSH_BRAKE','2026-09-01T10:01:00Z']);
    settle();const spy=vi.spyOn(pool,'getDb').mockImplementation(()=>{throw new Error('Client read touched source database');});
    const res=await request(app).get(`/api/vehicles/${car}/trips/${trip}/bundle`).set('Authorization',auth);
    expect(res.status).toBe(200);expect(res.body.events).toHaveLength(1);expect(res.body.route.type).toBe('FeatureCollection');
    expect(res.body.quality.pointCount).toBe(2);expect(spy).not.toHaveBeenCalled();
    const detail=await request(app).get(`/api/vehicles/${car}/detail`).set('Authorization',auth);expect(detail.status).toBe(200);
  });
  it('enforces fleet and vehicle scope, including cached bundles',async()=>{
    fixtureTrip();settle();
    expect(replicaSnapshot('trip',trip,'other-fleet',car)).toBeNull();
    expect(replicaSnapshot('trip',trip,fleet,'other-car')).toBeNull();
    const res=await request(app).get(`/api/vehicles/${car}/trips/${trip}/bundle`).set('Authorization','Bearer demo:other-fleet:fleet_manager');
    expect(res.status).toBe(404);
    expect((await request(app).get(`/api/vehicles/other-car/trips/${trip}/bundle`).set('Authorization',auth)).status).toBe(404);
  });
  it('paginates trip summaries without loading stored route or event payloads',async()=>{
    for(let n=1;n<=55;n++) fixtureTrip(`trip-${n}`,n);
    settle();
    const first=await request(app).get(`/api/vehicles/${car}/trips`).set('Authorization',auth);
    expect(first.body.trips).toHaveLength(50);expect(first.body.hasMore).toBe(true);
    expect(first.body.trips[0].events).toBeUndefined();expect(first.body.trips[0].route).toBeUndefined();
    const next=await request(app).get(`/api/vehicles/${car}/trips?offset=50`).set('Authorization',auth);
    expect(next.body.trips).toHaveLength(5);expect(next.body.hasMore).toBe(false);
  });
});

describe('cache and jobs',()=>{
  it('processes queued events in a separate process and bridges live updates over IPC',async()=>{
    const evt=ingestEvent(fleet,'conn_read','OEM-READ',{timestamp:'2026-09-01T10:00:00Z',speed_mph:20,charge_fraction:0.8,odo_miles:100,status:'running',lat:51.5,lon:-0.12,altitude:10,heading:90,harsh_brake:false},'process-event',true);
    const child=fork(fileURLToPath(new URL('../services/background-runtime.ts',import.meta.url)),[],{
      env:{...process.env,ZSPEED_BACKGROUND_WORKER:'true'},execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc'],
    });
    const messages:any[]=[];let errors='';child.on('message',m=>messages.push(m));child.stderr?.on('data',chunk=>errors+=chunk);
    try {
      child.send({type:'load',requests:20});
      const deadline=Date.now()+15000;
      while(Date.now()<deadline && !replicaSnapshot('vehicle',car,fleet)?.currentState) await new Promise(resolve=>setTimeout(resolve,100));
      expect(errors).toBe('');expect(child.pid).not.toBe(process.pid);
      expect(pool.queryOne<any>('SELECT processing_status FROM raw_events WHERE id=?',[evt.eventId]).processing_status).toBe('PROCESSED');
      expect(replicaSnapshot('vehicle',car,fleet).currentState.latestValues.vehicle_speed).toBeGreaterThan(0);
      expect(messages.some(m=>m.type==='fleet-event'&&m.event.vehicleId===car)).toBe(true);
    } finally {
      if(child.exitCode===null && child.signalCode===null) {
        await new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.kill();setTimeout(resolve,2000).unref();});
      }
    }
  },20000);
  it('uses cache hits without a database read and expires cached data',async()=>{
    const entries=new Map<string,string>();
    setCacheAdapterForTests({isReady:true,get:async key=>entries.get(key)||null,set:async(key,value,options)=>{expect(options.EX).toBe(5);entries.set(key,value);}});
    const load=vi.fn(()=>({value:42,freshness:{updatedAt:'now'}}));
    await cachedRead('fleet-a/car',load);await cachedRead('fleet-a/car',load);expect(load).toHaveBeenCalledTimes(1);
    entries.clear();await cachedRead('fleet-a/car',load);expect(load).toHaveBeenCalledTimes(2);
    await cachedRead('fleet-b/car',load);expect(load).toHaveBeenCalledTimes(3);
  });
  it('falls back when Redis fails or never replies',async()=>{
    setCacheAdapterForTests({isReady:true,get:async()=>{throw new Error('Offline');},set:async()=>{}});
    expect(await cachedRead('a',()=>({value:1}))).toMatchObject({value:1});
    setCacheAdapterForTests({isReady:true,get:()=>new Promise(()=>{}),set:async()=>{}});
    expect(await cachedRead('b',()=>({value:2}))).toMatchObject({value:2});
    await expect(bounded(new Promise(()=>{}),10)).rejects.toThrow('Cache timed out');
  });
  it('throttles maintenance during traffic while prioritizing an incoming-write backlog',()=>{
    expect(workerBudget(0,0,2)).toMatchObject({mode:'QUIET_HOURS',allowMaintenance:true});
    expect(workerBudget(10,0,12)).toMatchObject({mode:'BUSY',allowMaintenance:false,reads:1});
    expect(workerBudget(10,300,12).jobs).toBeGreaterThan(workerBudget(10,0,12).jobs);
  });
  it('enqueues rebuilds atomically and bounds maintenance deferral',()=>{
    const id=enqueueProjectionRebuild(car,fleet,null,null,'Test');
    expect(pool.queryOne<any>('SELECT fleet_id FROM job_queue WHERE json_extract(payload,\'$.jobId\')=?',[id]).fleet_id).toBe(fleet);
    expect(claimNextJob('test',false)).toBeNull();
    pool.run("UPDATE job_queue SET created_at=datetime('now','-11 minutes')");
    expect(claimNextJob('test',false).job_type).toBe('REBUILD_PROJECTIONS_JOB');
  });
  it('retries unsupported jobs instead of silently marking them completed',()=>{
    pool.run("INSERT INTO job_queue(id,job_type,payload) VALUES('unknown','UNSUPPORTED','{}')");
    const job=claimNextJob('test');executeClaimedJob(job);
    expect(pool.queryOne<any>("SELECT status,error FROM job_queue WHERE id='unknown'")).toMatchObject({status:'PENDING',error:'Unknown job type: UNSUPPORTED'});
  });
  it('replays a durable batch and resumes after the database is reopened',()=>{
    for(let n=0;n<3;n++) {
      const event=ingestEvent(fleet,'conn_read','OEM-READ',{invalid:`payload-${n}`},`bad-${n}`);
      processRawEvent(event.eventId);
    }
    const profile=pool.queryOne<any>("SELECT mp.id FROM mapping_profiles mp JOIN oem_format_versions ofv ON ofv.id=mp.oem_format_version_id WHERE ofv.oem_id='oem_voltera' AND mp.status='ACTIVE' LIMIT 1") || pool.queryOne<any>("SELECT id FROM mapping_profiles LIMIT 1");
    const replay=replayEvents(profile.id,{fleet_id:fleet});
    runReplayJob(replay.jobId,profile.id,1);
    expect(pool.queryOne<any>('SELECT status FROM replay_jobs WHERE id=?',[replay.jobId]).status).toBe('RUNNING');
    pool.closeDb();runReplayJob(replay.jobId,profile.id,1);runReplayJob(replay.jobId,profile.id,1);
    const result=pool.queryOne<any>('SELECT * FROM replay_jobs WHERE id=?',[replay.jobId]);
    expect(result).toMatchObject({status:'COMPLETED',total_events:3,error_events:3});
    expect(pool.queryOne<any>('SELECT COUNT(*) count FROM replay_job_items WHERE job_id=?',[replay.jobId]).count).toBe(3);
  });
  it('reports fleet job status from the replica without exposing other fleets',async()=>{
    saveSnapshot('jobs',fleet,'',fleet,{heartbeat:new Date().toISOString(),mode:'NORMAL',refresh:{pending:2,failed:0},activities:[{id:'mine',kind:'TELEMETRY'}]});
    saveSnapshot('jobs','other','', 'other',{heartbeat:new Date().toISOString(),activities:[{id:'private'}]});replicateReadModels(100);
    const res=await request(app).get('/api/backend-jobs').set('Authorization',auth);
    expect(res.status).toBe(200);expect(res.body.workerOnline).toBe(true);expect(res.body.activities.map((j:any)=>j.id)).toEqual(['mine']);
    expect(res.body.cache.ttlSeconds).toBe(5);
  });
});
