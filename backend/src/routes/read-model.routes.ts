import { Router } from 'express';
import { getFleetId } from '../middleware/fleet.js';
import { AppError } from '../middleware/error.js';
import { replicaSnapshot, openReadStore } from '../db/read-store.js';
import { cachedRead } from '../services/read-cache.service.js';

const router = Router();
const cacheKey = (...parts:string[]) => `zspeed:reads:v1:${JSON.stringify(parts)}`;
async function vehicle(id:string,fleet:string) {
  const result=await cachedRead(cacheKey(fleet,'vehicle',id),()=>replicaSnapshot('vehicle',id,fleet));
  if (!result) throw new AppError(404,'READ_MODEL_PENDING','Vehicle unavailable or its first read snapshot is still being prepared.');
  return result;
}
export function tripSummaries(vehicleId:string,fleetId:string,from?:string,to?:string,offset=0) {
  let sql="SELECT summary FROM snapshots WHERE kind='trip' AND vehicle_id=? AND fleet_id=? AND summary IS NOT NULL";
  const args:any[]=[vehicleId,fleetId];
  if (from) { sql+=' AND started_at>=?'; args.push(from); }
  if (to) { sql+=' AND started_at<=?'; args.push(to+'T23:59:59.999Z'); }
  sql+=' ORDER BY started_at DESC,entity_id LIMIT 51 OFFSET ?'; args.push(offset);
  const rows=openReadStore(true,true).prepare(sql).all(...args) as any[];
  return {trips:rows.slice(0,50).map(r=>JSON.parse(r.summary)),hasMore:rows.length>50,nextOffset:rows.length>50?offset+50:null};
}
router.get('/:vehicleId/detail',async(req,res,next)=>{
  try { res.json(await vehicle(req.params.vehicleId,getFleetId(req))); } catch(e) { next(e); }
});
router.get('/:vehicleId/trips',async(req,res,next)=>{
  try {
    const fleet=getFleetId(req); await vehicle(req.params.vehicleId,fleet);
    const offset=Math.max(0,Math.min(1000000,Number(req.query.offset)||0));
    res.json(tripSummaries(req.params.vehicleId,fleet,req.query.from as string,req.query.to as string,Math.floor(offset)));
  } catch(e) { next(e); }
});
router.get('/:vehicleId/trips/:tripId/:part(bundle|route|events|quality)',async(req,res,next)=>{
  try {
    const {vehicleId,tripId,part}=req.params;
    const fleet=getFleetId(req);
    const result=await cachedRead(cacheKey(fleet,'trip',vehicleId,tripId),()=>replicaSnapshot('trip',tripId,fleet,vehicleId));
    if (!result) throw new AppError(404,'READ_MODEL_PENDING','Trip unavailable or its read snapshot is still being prepared.');
    if (part==='bundle') res.json(result);
    else if (part==='events') res.json({events:result.events.filter((e:any)=>!req.query.event_type||e.event_type===req.query.event_type)});
    else res.json(result[part]);
  } catch(e) { next(e); }
});
export default router;
