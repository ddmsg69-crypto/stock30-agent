'use strict';
/* Stock30 browser-only morning LOCK view. Does not write to MASTER, LOCK or Google Drive. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object' && module.exports)module.exports=api;
  else root.Stock30WebMorning=api;
})(typeof globalThis==='object'?globalThis:this,()=>{
  const KIND='STOCK30_WEB_TODAY';
  const VERSION='1.1';
  const FILE_NAME='WEB_TODAY.json';
  const KST_MORNING_SWITCH='09:00';
  const day=now=>new Date(now.getTime()+9*3600000).toISOString().slice(0,10);
  const clock=now=>new Date(now.getTime()+9*3600000).toISOString().slice(11,16);
  function canDisplay(now=new Date()){return clock(now)>=KST_MORNING_SWITCH;}
  async function validate(raw,verify,{now=new Date()}={}){
    if(!verify || typeof verify.sealed!=='function' || typeof verify.official!=='function')throw Error('공식 LOCK 검증 모듈 미연결');
    if(typeof raw!=='string' || new TextEncoder().encode(raw).length>512*1024)throw Error('웹 아침 게시본 크기/형식 오류');
    const p=await verify.sealed(raw,'아침 WEB_TODAY');
    if(p.kind!==KIND || p.schema_version!==VERSION || p.publication_status!=='PUBLISHED')throw Error('아침 WEB_TODAY 운영 게시 상태 오류');
    if(p.as_of!==day(now))throw Error('아침 공식30 게시 대기 · 다른 날짜의 게시본');
    if(typeof p.official_lock!=='string' || p.official_lock.length>128*1024)throw Error('공식 LOCK 원문 누락/초과');
    if(typeof p.source_lock_sha256!=='string'|| !/^[a-f0-9]{64}$/.test(p.source_lock_sha256))throw Error('공식 LOCK 출처 해시 누락');
    if(typeof p.published_at!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(p.published_at)||!Number.isFinite(Date.parse(p.published_at)))throw Error('아침 게시 시각 형식 오류');
    const timestamp=new Date(p.published_at);
    if(day(timestamp)!==p.as_of||timestamp.getTime()>now.getTime()+5*60000)throw Error('아침 게시 시각과 날짜 불일치');
    const lock=await verify.sealed(p.official_lock,'공식 아침 LOCK');
    verify.official(lock,p.as_of);
    if(lock.sha256!==p.source_lock_sha256)throw Error('게시본과 공식 LOCK 원문 해시 불일치');
    if(typeof lock.created_at==='string' && Number.isFinite(Date.parse(lock.created_at)) && Date.parse(lock.created_at)>timestamp.getTime())throw Error('게시 시각이 공식 LOCK 선정 이전');
    return {date:p.as_of,lock,publishedAt:p.published_at,sourceHash:lock.sha256};
  }
  function cohort(verified){
    if(!verified||!verified.lock||!Array.isArray(verified.lock.stocks)||verified.lock.stocks.length!==30)throw Error('검증된 공식30이 아닙니다');
    return {date:verified.date,cohortId:verified.lock.cohort_id,stocks:[...verified.lock.stocks]
      .sort((a,b)=>a.rank-b.rank)
      .map(s=>({date:verified.date,cohortId:verified.lock.cohort_id,rank:s.rank,code:s.stock_code,
        name:s.stock_name,top5:s.top5,reason:s.Selection_Reason||'',record:null,observation:null,score:null,scoreIssue:null}))};
  }
  return {KIND,VERSION,FILE_NAME,day,clock,canDisplay,validate,cohort};
});
