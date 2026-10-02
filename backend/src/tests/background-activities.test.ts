import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runMigrations} from '../db/migrate.js';
import {getDb,run,queryOne,closeDb} from '../db/pool.js';
import {getBackgroundActivities} from '../services/background-activity.service.js';
import {createBackgroundRefresh} from '../../../frontend/src/background-refresh';

let directory:string;
beforeEach(()=>{
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'zspeed-activities-'));process.env.OVERRIDE_DB_PATH=path.join(directory,'test.db');runMigrations();
  run("INSERT INTO fleets(id,name) VALUES('fleet','Fleet'),('other','Other')");
  run("INSERT INTO vehicles(id,fleet_id,vin,label) VALUES('car','fleet','VIN','Van 1'),('car2','fleet','VIN2','Van 2'),('private','other','VIN3','Private')");
});
afterEach(()=>{closeDb();delete process.env.OVERRIDE_DB_PATH;fs.rmSync(directory,{recursive:true,force:true});});
function job(id:string,car='car',time='2026-10-02 10:00:00',type='BUILD_PROJECTIONS') {
  run('INSERT INTO job_queue(id,job_type,payload,created_at) VALUES(?,?,?,?)',[id,type,JSON.stringify({vehicleId:car}),time]);
}
describe('grouped background activities',()=>{
  it('groups continuous work, keeps a stable ID and splits after inactivity',()=>{
    job('one');job('two','car','2026-10-02 10:04:00');job('three','car','2026-10-02 10:08:00');
    expect(getBackgroundActivities('fleet')).toMatchObject([{id:'one',task_count:3,label:'Van 1',status:'QUEUED'}]);
    job('four','car','2026-10-02 10:14:00');
    expect(getBackgroundActivities('fleet')).toHaveLength(2);
    expect(queryOne<any>("SELECT activity_id FROM job_queue WHERE id='four'").activity_id).toBe('four');
  });
  it('separates vehicles and fleets and aggregates running, failed and completed work',()=>{
    job('one');job('two');job('third','car2');job('hidden','private');
    run("UPDATE job_queue SET status='RUNNING',started_at='2026-10-02 10:01:00' WHERE id='one'");
    run("UPDATE job_queue SET status='FAILED',error='Failed' WHERE id='two'");
    const activity=getBackgroundActivities('fleet').find(a=>a.id==='one');
    expect(activity).toMatchObject({running:1,failed:1,started_at:'2026-10-02 10:01:00',status:'RUNNING'});
    run("UPDATE job_queue SET status='DONE',completed_at='2026-10-02 10:03:00' WHERE id='one'");
    expect(getBackgroundActivities('fleet').find(a=>a.id==='one').status).toBe('NEEDS_ATTENTION');
    expect(getBackgroundActivities('fleet').map(a=>a.id)).not.toContain('hidden');
    expect(getBackgroundActivities('other')).toHaveLength(1);
  });
  it('preserves first start time across retries and database restart',()=>{
    job('one');run("UPDATE job_queue SET status='RUNNING',started_at='2026-10-02 10:01:00' WHERE id='one'");
    run("UPDATE job_queue SET status='PENDING' WHERE id='one'");
    run("UPDATE job_queue SET status='RUNNING',started_at='2026-10-02 10:02:00' WHERE id='one'");
    closeDb();runMigrations();
    expect(getBackgroundActivities('fleet')[0].started_at).toBe('2026-10-02 10:01:00');
  });
  it('keeps recovery jobs separate from ongoing vehicle updates',()=>{
    job('one');job('rebuild','car','2026-10-02 10:01:00','REBUILD_PROJECTIONS_JOB');
    expect(getBackgroundActivities('fleet')).toHaveLength(2);
  });
  it('groups raw event processing and trip calculations under the same vehicle activity',()=>{
    run("INSERT INTO supported_oems(id,name,code) VALUES('oem','OEM','OEM')");
    run("INSERT INTO oem_connections(id,fleet_id,oem_id,label) VALUES('connection','fleet','oem','Connection')");
    run("INSERT INTO vehicle_source_mappings(id,vehicle_id,connection_id,oem_vehicle_id) VALUES('mapping','car','connection','OEM-CAR')");
    run("INSERT INTO raw_events(id,fleet_id,connection_id,source_vehicle_id,payload_hash,payload,processing_status) VALUES('raw','fleet','connection','OEM-CAR','hash','{}','QUARANTINED')");
    run("INSERT INTO job_queue(id,job_type,payload,created_at) VALUES('process','NORMALIZE_RAW_EVENT','{\"rawEventId\":\"raw\"}','2026-10-02 10:00:00')");
    job('trip-update','car','2026-10-02 10:01:00');
    expect(getBackgroundActivities('fleet')).toMatchObject([{id:'process',vehicle_id:'car',event_count:1,task_count:2,review_count:1}]);
  });
  it('aggregates the entire activity rather than only the latest individual jobs',()=>{
    for(let i=0;i<80;i++)job(`job-${i}`);
    expect(getBackgroundActivities('fleet')[0].task_count).toBe(80);
  });
});
describe('background page refresh',()=>{
  it('coalesces notifications, retains visible data while pending and cancels stale responses',async()=>{
    const resolvers:Array<(value:number)=>void>=[];
    const fetch=vi.fn(()=>new Promise<number>(resolve=>resolvers.push(resolve)));
    let visible=10;const publish=vi.fn(value=>{visible=value;});
    const task=createBackgroundRefresh(fetch,publish,vi.fn());
    const first=task.refresh();for(let i=0;i<20;i++)void task.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);expect(visible).toBe(10);
    resolvers[0](11);await first;
    expect(visible).toBe(11);expect(fetch).toHaveBeenCalledTimes(2);
    task.dispose();resolvers[1](12);await Promise.resolve();await Promise.resolve();
    expect(visible).toBe(11);
  });
  it('keeps last results on a refresh failure and recovers on the next refresh',async()=>{
    let visible=10;const error=vi.fn();const fetch=vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(12);
    const task=createBackgroundRefresh(fetch,value=>{visible=value;},error);
    await task.refresh();expect(visible).toBe(10);expect(error).toHaveBeenCalledTimes(1);
    await task.refresh();expect(visible).toBe(12);task.dispose();
  });
});
