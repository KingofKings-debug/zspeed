import { useEffect, useState } from 'react';
import { api } from '../api';

function formatTime(value?:string|null) {
  if(!value) return 'Not started';
  const normalized=/Z$|[+-]\d\d:\d\d$/.test(value)?value:value.replace(' ','T')+'Z';
  return new Date(normalized).toLocaleString();
}
const workLabels:Record<string,string>={TELEMETRY:'Process vehicle data and update trips',REPLAY_JOB:'Recover held records',REBUILD_PROJECTIONS_JOB:'Recalculate trip history'};
const statusLabels:Record<string,string>={RUNNING:'In progress',QUEUED:'Scheduled',NEEDS_ATTENTION:'Needs attention',COMPLETED_WITH_ISSUES:'Completed · review required',COMPLETED:'Completed'};

export default function BackendJobs() {
  const [data,setData]=useState<any>(null);
  const [error,setError]=useState(false);
  useEffect(()=>{
    let active=true;
    let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{
      try {const value=await api.getBackendJobs();if(active){setData(value);setError(false);}}
      catch {if(active)setError(true);}
      finally {if(active)timer=setTimeout(load,5000);}
    };
    void load();
    return()=>{active=false;clearTimeout(timer);};
  },[]);
  const activities=data?.activities||[];
  return <div>
    <div className="section-header"><div><h1 className="section-title">Background Jobs</h1>
      <p className="section-subtitle">Track vehicle updates, data recovery and trip calculations.</p></div>
      {data && <span className="text-muted">Updated {formatTime(data.freshness?.updatedAt)}</span>}
    </div>
    {error && <div className="alert alert-warning" role="alert">Activity updates are temporarily delayed. Your last status is shown below.</div>}
    {!data?<div className="loading-state">Loading activity…</div>:<>
      <div className="card" style={{padding:20,marginBottom:20}}>
        <strong>{data.workerOnline?'Processing is available':'Processing updates are delayed'}</strong>
        <p>{data.mode==='BUSY'?'Vehicle data is prioritised while scheduled maintenance waits for capacity.':data.mode==='QUIET_HOURS'?'Scheduled maintenance and vehicle updates are in progress.':'Vehicle data and scheduled work are being processed normally.'}</p>
        <span>{data.refresh.pending} vehicle or trip updates pending · {data.refresh.failed} awaiting retry</span>
      </div>
      <h2 style={{fontSize:18}}>Recent activity</h2>
      <p className="text-muted">Continuous records from the same vehicle are grouped together. A new activity starts after five minutes without new work.</p>
      {!activities.length?<div className="empty-state">No recent background activity.</div>:<div style={{overflowX:'auto'}}>
        <table className="data-table"><thead><tr><th>Job ID / vehicle</th><th>Work</th><th>Status</th><th>Started</th><th>Latest activity</th><th>Progress</th></tr></thead>
          <tbody>{activities.map((activity:any)=><tr key={activity.id}>
            <td><div className="mono" title={activity.id}>JOB-{activity.id.slice(0,8).toUpperCase()}</div><div>{activity.label}</div></td>
            <td>{workLabels[activity.kind]||'Process scheduled work'}<div className="text-muted">{activity.event_count?`${activity.event_count} vehicle records · `:''}{activity.task_count} tasks</div></td>
            <td>{statusLabels[activity.status]||activity.status}{activity.retrying>0&&<div className="text-muted">{activity.retrying} tasks awaiting retry</div>}</td>
            <td>{formatTime(activity.started_at)}{!activity.started_at&&<div className="text-muted">Scheduled {formatTime(activity.queued_at)}</div>}</td>
            <td>{formatTime(activity.last_event_at)}{activity.completed_at&&!activity.pending&&!activity.running&&<div className="text-muted">Finished {formatTime(activity.completed_at)}</div>}</td>
            <td>{activity.completed} / {activity.task_count} tasks complete{activity.progress_pct!=null&&<div>{activity.progress_pct}% complete</div>}
              {!!(activity.review_count||activity.error_events)&&<div className="text-warning">{activity.review_count||activity.error_events} records need review</div>}
              {activity.failed>0&&<div className="text-warning">{activity.failed} tasks need attention</div>}
            </td>
          </tr>)}</tbody>
        </table>
      </div>}
    </>}
  </div>;
}
