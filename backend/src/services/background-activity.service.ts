import { query } from '../db/pool.js';

export function getBackgroundActivities(fleetId:string):any[] {
  return query<any>(`WITH recent AS (
    SELECT * FROM background_activities WHERE fleet_id=? ORDER BY last_queued_at DESC LIMIT 30
  ) SELECT a.id,a.kind,a.vehicle_id,a.label,a.first_queued_at queued_at,a.last_queued_at last_event_at,
    a.started_at,MAX(j.completed_at) completed_at,COUNT(j.id) task_count,
    SUM(j.job_type='NORMALIZE_RAW_EVENT') event_count,
    SUM(j.status='PENDING') pending,SUM(j.status='RUNNING') running,SUM(j.status='DONE') completed,
    SUM(j.status='FAILED') failed,SUM(j.error IS NOT NULL AND j.status='PENDING') retrying,
    SUM(j.job_type='NORMALIZE_RAW_EVENT' AND r.processing_status='QUARANTINED') review_count,
    MAX(rp.total_events) total_events,MAX(rp.processed_events) processed_events,MAX(rp.error_events) error_events,
    MAX(COALESCE(rp.progress_pct,pb.progress_pct)) progress_pct
    FROM recent a JOIN job_queue j ON j.activity_id=a.id
    LEFT JOIN raw_events r ON r.id=json_extract(j.payload,'$.rawEventId')
    LEFT JOIN replay_jobs rp ON rp.id=json_extract(j.payload,'$.jobId')
    LEFT JOIN projection_rebuild_jobs pb ON pb.id=json_extract(j.payload,'$.jobId')
    GROUP BY a.id ORDER BY a.last_queued_at DESC`,[fleetId]).map(activity=>({
      ...activity,status:activity.running?'RUNNING':activity.pending?'QUEUED':activity.failed?'NEEDS_ATTENTION':activity.review_count||activity.error_events?'COMPLETED_WITH_ISSUES':'COMPLETED',
    }));
}
