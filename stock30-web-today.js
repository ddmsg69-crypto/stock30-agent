'use strict';
/* Shared by the private dashboard and the separate, opt-in WEB_TODAY builder. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.Stock30WebToday=api;
})(typeof globalThis==='object'?globalThis:this,()=>{
  const FILE_NAME='WEB_TODAY.json';
  const KIND='STOCK30_WEB_TODAY';
  const MAX_BYTES=15*1024*1024;
  const requireValue=(ok,message)=>{if(!ok)throw Error(message)};
  const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&
    Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
  function today(now=new Date()){
    return new Date(now.getTime()+9*3600000).toISOString().slice(0,10);
  }
  async function digest(text){
    const result=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
    return Array.from(new Uint8Array(result),x=>x.toString(16).padStart(2,'0')).join('');
  }
  // Split only top-level members. Preserve Python's number spelling (1.0, 1e-06),
  // Unicode and every nested byte when verifying core.seal's canonical raw JSON.
  function members(raw){
    requireValue(typeof raw==='string'&&raw.startsWith('{')&&raw.endsWith('}'),'원문 JSON 객체가 필요합니다.');
    let depth=0,quoted=false,escaped=false,start=1;
    const parts=[];
    for(let i=1;i<raw.length-1;i++){
      const c=raw[i];
      if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue}
      if(c==='"')quoted=true;
      else if(c==='{'||c==='[')depth++;
      else if(c==='}'||c===']')depth--;
      else if(c===','&&depth===0){parts.push(raw.slice(start,i));start=i+1}
    }
    parts.push(raw.slice(start,-1));
    const keys=new Set();
    return parts.map(text=>{
      const match=/^\s*("(?:[^"\\]|\\.)*")\s*:/.exec(text);
      requireValue(!!match,'원문 JSON 필드 형식 오류');
      const key=JSON.parse(match[1]);
      requireValue(!keys.has(key),'원문 JSON 중복 필드');keys.add(key);
      return {key,text};
    });
  }
  async function sealed(raw,label){
    requireValue(typeof raw==='string'&&new TextEncoder().encode(raw).length<=MAX_BYTES,label+' 원문 크기 오류');
    const value=JSON.parse(raw),parts=members(raw.trim());
    requireValue(/^[0-9a-f]{64}$/.test(value.sha256||''),label+' SHA256 누락');
    const unsealed='{'+parts.filter(x=>x.key!=='sha256').map(x=>x.text).join(',')+'}';
    let valid=await digest(unsealed)===value.sha256;
    // Official LOCK exports may be pretty-printed. Its schema contains only
    // strings, booleans and integer ranks. Keep raw bytes outside this verifier;
    // never normalize numeric spelling in MASTER generations or Python floats.
    if(!valid&&value.locked===true&&value.status==='OFFICIAL'){
      const stack=[];
      for(let i=0;i<raw.length;i++){
        const c=raw[i];
        if(c==='{'||c==='[')stack.push({type:c,keys:new Set()});
        else if(c==='}'||c===']')stack.pop();
        else if(c==='"'){
          const start=i;let escaped=false;
          for(i++;i<raw.length;i++){if(escaped)escaped=false;else if(raw[i]==='\\')escaped=true;else if(raw[i]==='"')break;}
          const text=JSON.parse(raw.slice(start,i+1));let next=i+1;while(/\s/.test(raw[next]||'')&&next<raw.length)next++;
          if(raw[next]===':'){const object=stack.at(-1);requireValue(object?.type==='{'&&!object.keys.has(text),'LOCK 중복 JSON 필드');object.keys.add(text);}
        }else if(c==='-'||/[0-9]/.test(c)){
          let end=i+1;while(/[0-9eE+.-]/.test(raw[end]||'')&&end<raw.length)end++;
          const token=raw.slice(i,end);requireValue(/^-?(?:0|[1-9][0-9]*)$/.test(token)&&Number.isSafeInteger(Number(token)),'LOCK 정수 형식 오류');i=end-1;
        }
      }
      const canonical=x=>x&&typeof x==='object'?Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
      const copy={...value};delete copy.sha256;valid=await digest(canonical(copy))===value.sha256;
    }
    requireValue(valid,label+' SHA256 불일치');
    return value;
  }
  function official(lock,expectedDate){
    requireValue(lock.schema_version==='1.0'&&lock.locked===true&&lock.status==='OFFICIAL','Official LOCK 상태 오류');
    requireValue(day(lock.selection_date)&&lock.selection_date===expectedDate,'당일 Official LOCK 날짜 불일치');
    requireValue(typeof lock.cohort_id==='string'&&/^C_\d{4}-\d{2}-\d{2}(?:_[A-Za-z0-9_-]{1,30})?$/.test(lock.cohort_id)&&lock.cohort_id.slice(2,12)===lock.selection_date,'LOCK 코호트 날짜 오류');
    requireValue(Array.isArray(lock.stocks)&&lock.stocks.length===30,'Official30은 정확히 30종이어야 합니다.');
    const codes=new Set(),ranks=new Set();
    for(const s of lock.stocks){
      requireValue(s&&typeof s.stock_code==='string'&&/^\d{6}$/.test(s.stock_code)&&!codes.has(s.stock_code),'Official30 코드 중복/형식 오류');
      requireValue(Number.isInteger(s.rank)&&s.rank>=1&&s.rank<=30&&!ranks.has(s.rank),'Official30 순위 중복/형식 오류');
      requireValue(typeof s.stock_name==='string'&&s.stock_name.trim().length>0&&s.stock_name.length<=100,'Official30 종목명 오류');
      requireValue(s.locked===true&&s.top5===(s.rank<=5)&&s.top10===(s.rank<=10),'Official30 TOP5/TOP10/LOCK 플래그 오류');
      codes.add(s.stock_code);ranks.add(s.rank);
    }
    requireValue(lock.stocks.filter(s=>s.top5===true).length===5,'TOP5는 정확히 5종이어야 합니다.');
    return lock;
  }
  const fingerprint=lock=>JSON.stringify({cohort_id:lock.cohort_id,selection_date:lock.selection_date,
    stocks:[...lock.stocks].sort((a,b)=>a.rank-b.rank).map(s=>[s.rank,s.stock_code,s.stock_name,s.top5,s.top10,s.locked,s.Selection_Reason||''])});
  async function validateMaster(pointerRaw,generationRaw,{expectedDate=today()}={}){
    const [pointer,generation]=await Promise.all([
      sealed(pointerRaw,'MASTER 포인터'),sealed(generationRaw,'MASTER 생성본')]);
    for(const x of [pointer,generation]){
      requireValue(x.schema_version==='2.1'&&x.mode==='OFFICIAL'&&x.live_enabled===false&&x.validation_status==='PASS','OFFICIAL MASTER PASS가 필요합니다.');
      if(x===pointer||x.as_of!==undefined)requireValue(day(x.as_of)&&x.as_of<=expectedDate,'MASTER 날짜 오류');
    }
    requireValue(pointer.kind==='MASTER21_CURRENT'&&generation.kind==='MASTER21_GENERATION'&&(generation.as_of===undefined||pointer.as_of===generation.as_of),'MASTER 포인터/생성본 날짜·형식 불일치');
    requireValue(pointer.generation===generation.sha256&&pointer.bundle_sha256===await digest(generationRaw),'MASTER generation 해시 불일치');
    requireValue(pointer.PRICE_POLICY_VERSION===generation.PRICE_POLICY_VERSION,'MASTER 가격 정책 불일치');
    const names=['master_database.csv','master_active.csv','master_history.csv','master_state.json','master_5day_board.json','master_momentum.json','master_top5_reason.json'];
    requireValue(pointer.files&&generation.files&&JSON.stringify(Object.keys(pointer.files).sort())===JSON.stringify(names.slice().sort())&&JSON.stringify(Object.keys(generation.files).sort())===JSON.stringify(names.slice().sort()),'MASTER 내부 파일 목록 오류');
    for(const name of names){
      requireValue(typeof generation.files[name]==='string'&&await digest(generation.files[name])===pointer.files[name],name+' 원문 해시 불일치');
    }
    const master=await sealed(generation.files['master_state.json'],'MASTER state');
    requireValue(master.mode==='OFFICIAL'&&master.live_enabled===false&&master.as_of===pointer.as_of&&Array.isArray(master.database)&&master.database.length===pointer.record_count&&Array.isArray(master.locked_selections),'MASTER 본문 날짜/건수/LOCK 오류');
    requireValue(master.locked_selections.every(x=>day(x.selection_date)&&x.selection_date<=expectedDate),'MASTER LOCK 미래/잘못된 날짜');
    return {pointer,generation,master};
  }
  async function validate(payload,{expectedDate=today(),previousLock=null}={}){
    requireValue(payload&&payload.kind===KIND&&payload.schema_version==='1.0','WEB_TODAY 형식 오류');
    requireValue(new TextEncoder().encode(JSON.stringify(payload)).length<=MAX_BYTES,'WEB_TODAY 15MB 제한 초과');
    requireValue(day(expectedDate)&&payload.as_of===expectedDate,'WEB_TODAY가 한국 날짜 당일 자료가 아닙니다.');
    requireValue(typeof payload.published_at==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(payload.published_at)&&Number.isFinite(Date.parse(payload.published_at))&&today(new Date(payload.published_at))===expectedDate,'WEB_TODAY 게시 날짜 오류');
    const {pointer,generation,master}=await validateMaster(payload.master_pointer,payload.master_generation,{expectedDate});
    const lock=await sealed(payload.official_lock,'Official LOCK');
    official(lock,expectedDate);
    const sameDay=master.locked_selections.filter(x=>x.selection_date===expectedDate);
    requireValue(sameDay.length<=1,'MASTER 당일 LOCK 중복');
    for(const existing of [...sameDay,...(previousLock?.selection_date===expectedDate?[previousLock]:[])]){
      official(existing,expectedDate);
      requireValue(fingerprint(existing)===fingerprint(lock),'당일 기존 LOCK과 충돌합니다.');
    }
    // No price synthesis: morning LOCK may be newer than yesterday's MASTER.
    const rows=master.database.filter(r=>r['Cohort Date']===expectedDate);
    if(rows.length){
      requireValue(rows.length===30&&new Set(rows.map(r=>r['Stock Code'])).size===30,'MASTER 당일 30종 불일치');
      for(const r of rows){const s=lock.stocks.find(x=>x.stock_code===r['Stock Code']);
        const flag=r.TOP5===true||r.TOP5==='True'||r.TOP5==='1'||r.TOP5===1;
        requireValue(!!s&&flag===s.top5&&r.Cohort_ID===lock.cohort_id,'MASTER 당일 LOCK/TOP5 불일치');
      }
    }
    return {pointer,generation,lock,master,date:expectedDate,publishedAt:payload.published_at};
  }
  return {FILE_NAME,KIND,MAX_BYTES,today,digest,sealed,official,fingerprint,validateMaster,validate};
});
