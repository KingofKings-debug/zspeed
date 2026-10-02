/** Coalesce repeated notifications; never overlap requests or publish after disposal. */
export function createBackgroundRefresh<T>(fetchData:()=>Promise<T>,onData:(value:T)=>void,onError:(error:any)=>void) {
  let active=true,inFlight=false,again=false;
  const refresh=async()=>{
    if(!active)return;
    if(inFlight){again=true;return;}
    inFlight=true;
    try{const value=await fetchData();if(active)onData(value);}
    catch(error){if(active)onError(error);}
    finally{inFlight=false;if(active&&again){again=false;void refresh();}}
  };
  return {refresh,dispose:()=>{active=false;again=false;}};
}
