import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cachedRead,cacheStatus,closeReadCache } from '../services/read-cache.service.js';

// Opt-in integration test: RUN_DOCKER_TESTS=1 npm test -- src/tests/redis-container.test.ts
describe.skipIf(process.env.RUN_DOCKER_TESTS!=='1')('real Redis cache container',()=>{
  const name=`zspeed-cache-test-${randomUUID()}`;
  const previous=process.env.REDIS_URL;
  beforeAll(async()=>{
    execFileSync('docker',['run','--rm','-d','--name',name,'-p','127.0.0.1::6379','redis:7.4-alpine'],{timeout:120000,stdio:'pipe'});
    const mapping=execFileSync('docker',['port',name,'6379/tcp'],{encoding:'utf8'}).trim();
    process.env.REDIS_URL=`redis://${mapping}`;
    const deadline=Date.now()+15000;
    while(!cacheStatus().available&&Date.now()<deadline) {await cachedRead('probe',()=>({ok:true}));await new Promise(resolve=>setTimeout(resolve,100));}
    expect(cacheStatus().available).toBe(true);
  },130000);
  afterAll(()=>{closeReadCache();if(previous===undefined)delete process.env.REDIS_URL;else process.env.REDIS_URL=previous;try{execFileSync('docker',['rm','-f',name],{stdio:'pipe',timeout:10000});}catch{}});
  it('serves cache hits, expires data and falls back after the Redis server stops',async()=>{
    let loads=0;const load=()=>({value:++loads});
    await cachedRead('integration-car',load);
    await new Promise(resolve=>setTimeout(resolve,100));
    expect((await cachedRead('integration-car',load)).value).toBe(1);
    const ttl=Number(execFileSync('docker',['exec',name,'redis-cli','TTL','integration-car'],{encoding:'utf8'}));
    expect(ttl).toBeGreaterThan(0);expect(ttl).toBeLessThanOrEqual(5);
    await new Promise(resolve=>setTimeout(resolve,5200));
    expect((await cachedRead('integration-car',load)).value).toBe(2);
    execFileSync('docker',['stop',name],{stdio:'pipe',timeout:10000});
    await new Promise(resolve=>setTimeout(resolve,200));
    expect((await cachedRead('integration-offline',load)).value).toBe(3);
  },20000);
});
