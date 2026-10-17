'use strict';
/* Stock30 private read-only browser dashboard. MASTER never leaves the user's browser or Google Drive. */
(() => {
  const $ = id => document.getElementById(id);
  const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fixed = (x,n=1) => Number.isFinite(Number(x)) && x!=='' && x!==null && x!==undefined ? Number(x).toFixed(n) : '—';
  const num = x => x===null || x===undefined || x==='' ? null : Number.isFinite(Number(x))?Number(x):null;
  const comma = x => num(x)===null?'—':Math.round(num(x)).toLocaleString('ko-KR');
  const money = x => num(x)===null?'—':comma(x)+'원';
  const pct = x => num(x)===null?'—':`${num(x)>=0?'+':''}${num(x).toFixed(2)}%`;
  const code = x => String(x ?? '').trim().replace(/^\D?(\d+)$/,(_,d)=>d.padStart(6,'0'));
  const statusText = {SUCCESS:'SUCCESS',FAIL:'FAIL',TRACKING:'추적중',PENDING:'D+1 대기',WAIT:'확인 대기'};
  const fmtDay = x => typeof x==='string' && /^\d{4}-\d{2}-\d{2}$/.test(x)?x:'—';
  const k = (obj,key) => obj && Object.prototype.hasOwnProperty.call(obj,key) ? obj[key] : undefined;
  const EMPTY = Object.freeze({masterPointer:null,generation:null,lock:null,scoreSnapshot:null});
  const state = {
    token:'',email:'',config:null,pickerLoaded:false,files:{...EMPTY},fileIds:{},mode:'none',refreshing:false,
    model:null,tab:'stocks',filter:'all',search:'',sort:'rank',selectedKey:'',selectedCohort:'',error:''
  };
  const SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';
  // Public web-OAuth client identifier (not a credential). Never embed secrets or access tokens.
  const WEB_CLIENT_ID = '630353141400-muc7pvh4q1hg793t221m3kpqq27h098e.apps.googleusercontent.com';
  // The numeric prefix normally corresponds to the Cloud project number; verify in Cloud Console before Picker setup.
  const SUGGESTED_PROJECT_NUMBER = '630353141400';
  const CONF_KEY = 'stock30-private-public-oauth-config-v1';
  const FILE_CACHE_KEY = 'stock30-private-remembered-file-ids-v1';
  let tokenClient = null;
  let tokenExpiry = 0;
  const safeError = e => {
    const raw = String(e && e.message || e || '알 수 없는 오류');
    // Never leak bearer tokens, Google API keys or large provider response payloads to page/log.
    return raw.slice(0,250).replace(/ya29\.[a-z0-9._-]+/gi,'[REDACTED]');
  };
  function status(text,bad=false){$('dataStatus').textContent=text;$('dataStatus').className=bad?'negative':'';}
  function showError(label,e){$('workflowSection').classList.remove('compact');$('toggleConnection').textContent='접기';status(`${label}: ${safeError(e)}`,true);}
  function isValidClientId(s){return /^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(s);}
  function configValues(){return {clientId:WEB_CLIENT_ID,apiKey:$('apiKey').value.trim(),projectNumber:$('projectNumber').value.trim() || SUGGESTED_PROJECT_NUMBER};}
  function verifyOAuthClient(conf){
    if(!isValidClientId(conf?.clientId))throw Error('웹용 OAuth 클라이언트 ID 형식을 확인해 주세요.');
  }
  function verifyPickerConfig(conf){
    verifyOAuthClient(conf);
    if(!/^AIza[\w-]{20,}$/.test(conf.apiKey||''))throw Error('Google Picker 연결용 API 키가 필요합니다. ⚙ 연결 관리에서 API 키를 등록해 주세요.');
    if(!/^\d{6,20}$/.test(conf.projectNumber||''))throw Error('Google Cloud 프로젝트 번호를 확인해 주세요.');
  }
  function saveConfig(){try{
    let c=configValues();verifyPickerConfig(c);localStorage.setItem(CONF_KEY,JSON.stringify(c));state.config=c;
    $('settingsPanel').hidden=true;status('Google Picker 설정을 저장했습니다. 로그인 상태라면 MASTER 파일을 선택할 수 있습니다.');
  }catch(e){showError('설정 확인',e)}}
  function bootstrap(){
    // Google login works immediately with the public client ID; Picker credentials are optional until file selection.
    let saved=null;
    try{saved=JSON.parse(localStorage.getItem(CONF_KEY)||'null')}catch(_){/* ignore invalid settings */}
    state.config={clientId:WEB_CLIENT_ID,apiKey:saved?.apiKey||'',projectNumber:saved?.projectNumber||SUGGESTED_PROJECT_NUMBER};
    $('clientId').value=WEB_CLIENT_ID;
    $('clientId').readOnly=true;
    $('apiKey').value=state.config.apiKey;
    $('projectNumber').value=state.config.projectNumber;
    $('settingsPanel').hidden=true;
    $('welcomeLoginBtn').addEventListener('click',signIn);
    $('forgetFilesBtn').addEventListener('click',forgetRemembered);
    $('welcomeHint').textContent='Google 계정을 선택해 로그인할 수 있습니다. 첫 MASTER 연결 시에는 파일 접근을 한 번 승인해야 합니다.';
    $('settingsBtn').addEventListener('click',()=>{$('settingsPanel').hidden=!$('settingsPanel').hidden});
    $('closeSettingsBtn').addEventListener('click',()=>{$('settingsPanel').hidden=true});
    $('toggleConnection').addEventListener('click',()=>{const c=$('workflowSection').classList.toggle('compact');$('toggleConnection').textContent=c?'연결 관리 펼치기':'접기'});
    $('saveConfigBtn').addEventListener('click',saveConfig);
    $('loginBtn').addEventListener('click',signIn);
    $('logoutBtn').addEventListener('click',signOut);
    $('pickPointerBtn').addEventListener('click',()=>openPicker('masterPointer'));
    $('refreshMasterBtn').addEventListener('click',()=>refreshCurrentMaster(true));
    setInterval(()=>{if(state.token&&state.mode==='drive'&&state.model&&document.visibilityState==='visible')refreshCurrentMaster(false)},300000);
    $('pickGenerationBtn').addEventListener('click',()=>openPicker('generation'));
    $('pickExtraBtn').addEventListener('click',()=>openPicker('extra'));
    $('localImport').addEventListener('change',localImport);
    $('clearBtn').addEventListener('click',clearData);
    $('search').addEventListener('input',e=>{state.search=e.target.value.trim().toLowerCase();renderContent()});
    $('sort').addEventListener('change',e=>{state.sort=e.target.value;renderContent()});
    $('tabs').addEventListener('click',e=>{const b=e.target.closest('button[data-tab]');if(!b)return;state.tab=b.dataset.tab;renderAll()});
    $('filters').addEventListener('click',e=>{const b=e.target.closest('button[data-filter]');if(!b)return;state.filter=b.dataset.filter;renderContent()});
    $('content').addEventListener('click',e=>{
      const b=e.target.closest('[data-select]');if(b){state.selectedKey=b.dataset.select;renderAll();return}
      const d=e.target.closest('[data-cohort]');if(d){state.selectedCohort=d.dataset.cohort;state.tab='stocks';state.filter='all';state.selectedKey='';renderAll()}
    });
    updateConnection();renderAll();
  }
  function updateConnection(){
    const connected=!!state.token && Date.now()<tokenExpiry;
    $('loginBtn').disabled=connected;
    $('logoutBtn').disabled=!connected;
    ['pickPointerBtn','pickGenerationBtn','pickExtraBtn'].forEach(id=>$(id).disabled=!connected);
    $('loginState').textContent=connected?'연결됨':'대기';
    $('authUser').textContent=connected?`Google: ${state.email || '계정 확인 중'}`:state.mode==='local'?'로컬 파일 읽기 모드':'Google 로그인 필요';
    $('welcomePanel').hidden=connected||!!state.model;
    $('workflowSection').hidden=!connected && !state.model;
    $('welcomeHint').textContent='Google 계정 로그인 · 비공개 MASTER는 파일 접근을 승인한 뒤에만 읽습니다.';
    $('connectionChip').textContent=connected?'● Google Drive 연결됨':state.mode==='local'?'● 로컬 자료 미리보기':'● Drive 미연결';
  }
  async function signIn(){
    try {
      const c=state.config || configValues();
      verifyOAuthClient(c);
      state.config=c;
      if(!window.google?.accounts?.oauth2)throw Error('Google Identity Services 로딩 실패. 잠시 후 새로고침해 주세요.');
      // Token model: access token is kept only in memory; no refresh token in public JavaScript.
      if(!tokenClient)tokenClient=google.accounts.oauth2.initTokenClient({
        client_id:c.clientId,scope:SCOPE,include_granted_scopes:false,
        callback:async response=>{
          if(response.error){showError('Google OAuth',response.error);return}
          if(!google.accounts.oauth2.hasGrantedAllScopes(response,...SCOPE.split(' '))){
            status('필요한 범위(drive.file, 이메일 확인)가 승인되지 않았습니다.',true);return;
          }
          state.token=response.access_token;tokenExpiry=Date.now()+(Number(response.expires_in||3000)-90)*1000;
          try{
            const profile=await authFetch('https://www.googleapis.com/oauth2/v3/userinfo');
            if(state.email && state.email!==profile.email)clearData();
            state.email=profile.email||'';
            updateConnection();
            status(`Google 로그인 완료 (${state.email || '계정'}). 기억한 MASTER 연결을 확인하고 있습니다...`);
            await restoreRememberedFiles();
          }catch(e){
            if(!state.email){state.token='';tokenExpiry=0;showError('Google 계정 확인',e);}
            else showError('MASTER 자동 불러오기',e);
          }
          updateConnection();
        },
        error_callback:er=>status(`Google 로그인 창 오류: ${String(er.type||'unknown')}`,true)
      });
      tokenClient.requestAccessToken({prompt:'select_account'});
    }catch(e){showError('Google 로그인 준비',e)}
  }
  function signOut(){
    // Clear local auth state. Google account's app grants are NOT revoked.
    state.token='';state.email='';tokenExpiry=0;clearData();updateConnection();status('브라우저 인증 상태를 종료했습니다. Google 계정 권한 자체는 유지됩니다.');
  }
  async function authFetch(url){
    if(!state.token || Date.now()>=tokenExpiry){state.token='';tokenExpiry=0;updateConnection();throw Error('인증이 만료됐습니다. Google에 다시 로그인해 주세요.');}
    const r=await fetch(url,{headers:{Authorization:`Bearer ${state.token}`},cache:'no-store',redirect:'error'});
    if(!r.ok)throw Error(`Google API HTTP ${r.status}${r.status===403?' (권한 또는 API 설정 확인)':''}${r.status===404?' (파일 접근 권한/선택 여부 확인)':''}`);
    return r.json();
  }
  async function loadPicker(){
    if(window.google?.picker)return;
    if(!window.gapi?.load)throw Error('Google Picker 스크립트를 가져오지 못했습니다. 새로고침해 주세요.');
    await new Promise((resolve,reject)=>{
      let finished=false;
      const end=(e)=>{if(finished)return;finished=true;e?reject(e):resolve()};
      try{gapi.load('picker',{callback:()=>end(),onerror:()=>end(Error('Picker 로딩 실패')),timeout:10000,ontimeout:()=>end(Error('Picker 로딩 시간 초과'))})}
      catch(e){end(e)}
    });
    if(!window.google?.picker)throw Error('Google Picker를 초기화하지 못했습니다.');
  }
  async function openPicker(kind){
    try{
      const cfg=state.config;verifyPickerConfig(cfg);
      if(!state.token || Date.now()>=tokenExpiry){state.token='';tokenExpiry=0;updateConnection();throw Error('Google 로그인부터 다시 진행해 주세요.');}
      await loadPicker();
      const view=new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false).setMode(google.picker.DocsViewMode.LIST);
      const picker=new google.picker.PickerBuilder()
        .addView(view).setOAuthToken(state.token).setDeveloperKey(cfg.apiKey).setAppId(cfg.projectNumber)
        .setOrigin(window.location.origin).setTitle(kind==='masterPointer'?'master_current.json 선택':kind==='generation'?'master21_generation_*.json 선택':'공식 LOCK 또는 학습 점수 JSON 선택')
        .setCallback(data=>{
          if(data[google.picker.Response.ACTION]!==google.picker.Action.PICKED)return;
          const list=data[google.picker.Response.DOCUMENTS]||[];
          if(!list.length)return;
          const file=list[0],id=file[google.picker.Document.ID]||file.id,name=file[google.picker.Document.NAME]||file.name||'';
          if(!id)return status('선택된 Google 파일 ID가 없습니다.',true);
          ingestDriveFile(kind,id,name);
        }).build();
      picker.setVisible(true);
    }catch(e){showError('Google 파일 선택기',e)}
  }
  async function ingestDriveFile(kind,id,name){
    try{
      status(`${name||'선택한 파일'} 읽는 중...`);
      const json=await authFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
      const inferred=detectType(json);
      if(kind!=='extra' && inferred!==kind)throw Error(`잘못 선택된 파일입니다. 기대: ${kind==='masterPointer'?'master_current.json':'master21_generation_*.json'}`);
      if(kind==='extra' && !['lock','scoreSnapshot'].includes(inferred))throw Error('공식 선정 LOCK 또는 학습 점수 스냅샷 JSON을 선택해 주세요.');
      const type=kind==='extra'?inferred:kind;
      if(type==='masterPointer' && name && name!=='master_current.json')throw Error('포인터 파일명이 master_current.json이 아닙니다.');
      state.files[type]=json;state.fileIds[type]=id;state.mode='drive';
      assemble();rememberFiles();
      if(type==='masterPointer' && !state.model)status('MASTER 포인터 PASS. 검증 생성본을 한 번 선택해 주세요.');
      else status(`${name||type} 읽기 PASS. ${state.model?'검증된 MASTER 표시 중':'다음 필수 파일을 선택해 주세요.'}`);
    }catch(e){state.model=null;renderAll();showError('Drive 파일 조회',e)}
  }
  function rememberFiles(){
    if(!state.email||state.mode!=='drive')return;
    try{localStorage.setItem(FILE_CACHE_KEY,JSON.stringify({email:state.email,ids:{...state.fileIds},savedAt:new Date().toISOString()}))}
    catch(_){status('이 브라우저에서 파일 연결 기억을 저장하지 못했습니다. 다음 방문 시 다시 선택해야 할 수 있습니다.',true)}
  }
  function forgetRemembered(){
    try{localStorage.removeItem(FILE_CACHE_KEY)}catch(_){}
    status('이 기기에 저장된 파일 연결 기록을 지웠습니다. 다음 방문 시 파일을 다시 선택해 주세요.');
  }
  async function restoreRememberedFiles(){
    let cached=null;
    try{cached=JSON.parse(localStorage.getItem(FILE_CACHE_KEY)||'null')}catch(_){}
    if(!cached || cached.email!==state.email || !cached.ids?.masterPointer){
      status(state.config.apiKey ? 'Google 로그인 완료. 처음 한 번만 MASTER 포인터와 검증 생성본을 선택해 주세요. 이후에는 자동 불러오기를 시도합니다.' : 'Google 로그인 완료! 비공개 MASTER를 처음 연결하려면 ⚙ 연결 관리에서 Google Picker API 키를 1회 등록해 주세요.');
      return;
    }
    const fetchId=async id=>authFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
    let pointer;
    try{pointer=await fetchId(cached.ids.masterPointer)}
    catch(e){status('저장된 MASTER 포인터의 Drive 접근이 거부됐습니다. 「MASTER 포인터」를 다시 선택해 주세요.',true);return}
    if(detectType(pointer)!=='masterPointer'||pointer.validation_status!=='PASS'){
      status('저장된 MASTER 포인터가 검증된 형식이 아닙니다. 파일을 다시 선택해 주세요.',true);return;
    }
    state.files.masterPointer=pointer;state.fileIds.masterPointer=cached.ids.masterPointer;
    const latestId=pointer.location;
    if(!latestId || !/^[A-Za-z0-9_-]{10,}$/.test(latestId)){
      status('MASTER 포인터 안에 유효한 generation 파일 ID가 없습니다.',true);return;
    }
    let generation;
    try{generation=await fetchId(latestId)}catch(e){
      status('새 MASTER generation에 아직 웹 권한이 없습니다. 「검증 생성본」을 눌러 최신 파일을 한 번 선택해 주세요. (Windows가 새로 생성한 파일은 drive.file 권한에 자동 추가되지 않을 수 있습니다.)',true);
      return;
    }
    if(detectType(generation)!=='generation'){
      status('최신 generation 형식을 확인할 수 없습니다. 파일 재선택이 필요합니다.',true);return;
    }
    state.files.generation=generation;state.fileIds.generation=latestId;
    for(const type of ['lock','scoreSnapshot']){
      const id=cached.ids[type];if(!id)continue;
      try{const extra=await fetchId(id);if(detectType(extra)===type){state.files[type]=extra;state.fileIds[type]=id;}}catch(_){/* Optional extra is not required for MASTER. */}
    }
    state.mode='drive';assemble();rememberFiles();
    status(`Google 로그인 PASS · 검증 MASTER ${pointer.as_of} 자동 불러오기 PASS · ${state.model?.db.length||0}건`);
  }
  // Read-only latest pointer check. Never overwrite the displayed model until full validation passes.
  // Google drive.file may require a one-time Picker grant for each newly published generation.
  async function refreshCurrentMaster(manual=false){
    if(state.refreshing)return;
    if(!state.token||Date.now()>=tokenExpiry){if(manual)status('Google 로그인이 만료됐습니다. 다시 로그인해 주세요.',true);return;}
    if(!state.fileIds.masterPointer){if(manual)status('MASTER 포인터부터 선택해 주세요.',true);return;}
    state.refreshing=true;
    try{
      const pointer=await authFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(state.fileIds.masterPointer)}?alt=media`);
      if(detectType(pointer)!=='masterPointer'||pointer.validation_status!=='PASS')throw Error('최신 포인터 검증 PASS가 아닙니다.');
      if(state.model&&pointer.generation===state.model.pointer.generation){if(manual)status(`MASTER 최신 확인 · ${pointer.as_of} · ${state.model.db.length}건`);return;}
      if(!/^[A-Za-z0-9_-]{10,}$/.test(pointer.location||''))throw Error('generation 파일 ID가 잘못됐습니다.');
      let generation;
      try{generation=await authFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(pointer.location)}?alt=media`);}
      catch(e){status(`새 MASTER ${pointer.as_of}가 게시됐지만 파일 접근 승인이 필요합니다. 3번 검증 생성본에서 새 파일을 선택해 주세요. 기존 화면은 유지됩니다.`,true);return;}
      if(detectType(generation)!=='generation')throw Error('generation 형식 오류');
      const files=state.files,ids=state.fileIds,model=state.model;
      try{
        state.files={...files,masterPointer:pointer,generation};
        state.fileIds={...ids,generation:pointer.location};
        assemble();rememberFiles();
        status(`MASTER 최신화 PASS · ${pointer.as_of} · ${state.model.db.length}건`);
      }catch(e){state.files=files;state.fileIds=ids;state.model=model;renderAll();throw e;}
    }catch(e){status(`최신 MASTER 확인 실패: ${safeError(e)} · 기존 화면 유지`,true);}
    finally{state.refreshing=false;}
  }
  function detectType(a){
    if(!a||typeof a!=='object')return null;
    if(a.kind==='MASTER21_CURRENT'&&typeof a.location==='string'&&a.files)return 'masterPointer';
    if(a.kind==='MASTER21_GENERATION'&&typeof a.files?.['master_state.json']==='string')return 'generation';
    if(a.locked===true&&Array.isArray(a.stocks)&&a.selection_date)return 'lock';
    if(Array.isArray(a.snapshots)&&a.score_definitions)return 'scoreSnapshot';
    return null;
  }
  async function localImport(event){
    const items=Array.from(event.target.files||[]);
    if(!items.length)return;
    let count=0;
    try{
      // Loaded JSON is never sent over the network, and is not retained in browser storage.
      for(const f of items){
        if(f.size>15*1024*1024)throw Error(`${f.name}: 파일 15MB 제한을 초과했습니다.`);
        const obj=JSON.parse(await f.text());const type=detectType(obj);
        if(!type)throw Error(`${f.name}: 지원하지 않는 Stock30 JSON 형식입니다.`);
        state.files[type]=obj;delete state.fileIds[type];count++;
      }
      state.mode='local';assemble();updateConnection();
      status(`${count}개 파일을 이 브라우저 안에서 읽었습니다.${state.model?' 검증된 데이터로 대시보드를 표시합니다.':' MASTER 포인터·생성본 두 파일이 필요합니다.'}`);
    }catch(e){state.model=null;renderAll();showError('로컬 JSON 읽기',e)}finally{event.target.value=''}
  }
  function clearData(){state.files={...EMPTY};state.fileIds={};state.model=null;state.selectedKey='';state.selectedCohort='';state.mode='none';renderAll();updateConnection()}
  function safeParse(s,name){try{return JSON.parse(s)}catch(_){throw Error(`${name} 내부 JSON 파싱 실패`)}}
  function assemble(){
    const p=state.files.masterPointer,g=state.files.generation;
    if(!p||!g){state.model=null;renderAll();return}
    if(p.validation_status!=='PASS'||g.validation_status!=='PASS')throw Error('검증 PASS가 아닌 MASTER는 사용할 수 없습니다.');
    if(g.sha256!==p.generation)throw Error('MASTER 포인터와 generation 해시 식별자가 불일치합니다.');
    if(state.fileIds.generation && p.location!==state.fileIds.generation)throw Error('generation과 포인터가 다릅니다. 최신 MASTER 포인터를 다시 선택해 주세요.');
    if(p.schema_version!=='2.1'||g.schema_version!=='2.1')throw Error('MASTER 2.1 형식이 아닙니다.');
    if(p.PRICE_POLICY_VERSION!==g.PRICE_POLICY_VERSION)throw Error('MASTER 가격 정책 버전이 일치하지 않습니다.');
    const master=safeParse(g.files['master_state.json'],'master_state.json');
    const board=safeParse(g.files['master_5day_board.json'],'master_5day_board.json');
    const momentum=safeParse(g.files['master_momentum.json'],'master_momentum.json');
    const top5reason=safeParse(g.files['master_top5_reason.json'],'master_top5_reason.json');
    if(master.as_of!==p.as_of)throw Error('MASTER 포인터 as_of와 generation 본문 날짜가 불일치합니다.');
    if(!Array.isArray(master.database)||master.database.length!==p.record_count)throw Error('MASTER DB 건수가 검증된 포인터 건수와 다릅니다.');
    const db=master.database.map(r=>{
      const date=String(r['Cohort Date']||'');const id=code(r['Stock Code']);const c=master.data_classification?.[date+'|'+id]||'UNKNOWN';
      return {...r,__date:date,__code:id,__dataClass:c};
    });
    const official=db.filter(r=>r.__dataClass==='OFFICIAL_NEW_BASELINE');
    const legacy=db.filter(r=>r.__dataClass==='LEGACY_REFERENCE');
    const registered=Array.isArray(master.locked_selections)?master.locked_selections:[];
    const ext=state.files.lock;
    if(ext && !(ext.locked===true && ext.status==='OFFICIAL' && ext.stocks?.length===30))throw Error('공식 LOCK 형식과 종목 수를 확인해 주세요.');
    const locked=[...registered];
    if(ext){const i=locked.findIndex(x=>x.selection_date===ext.selection_date);if(i>=0)locked[i]=ext;else locked.push(ext)}
    locked.sort((a,b)=>String(a.selection_date).localeCompare(String(b.selection_date)));
    const scores=scoreIndex(state.files.scoreSnapshot);
    const masterByKey=new Map(db.map(r=>[r.__date+'|'+r.__code,r]));
    const cohorts=locked.map(c=>({date:c.selection_date,cohortId:c.cohort_id,stocks:(c.stocks||[]).map(s=>{
      const record=masterByKey.get(c.selection_date+'|'+code(s.stock_code));
      const candidate=scores.get(scoreKey(c.selection_date,c.cohort_id,s.stock_code));
      const scoreIssue=scoreMismatch(candidate,c,s);
      const score=scoreIssue?null:candidate;
      return {date:c.selection_date,cohortId:c.cohort_id,rank:Number(s.rank||s['Selection Rank']||0),code:code(s.stock_code),name:s.stock_name||'이름 없음',top5:!!s.top5,reason:s.Selection_Reason||'',record,score,scoreIssue};
    })}));
    const latest=cohorts.at(-1);
    state.model={pointer:p,generation:g,master,board,momentum,top5reason,db,official,legacy,cohorts,scores,masterByKey};
    $('workflowSection').classList.add('compact');$('toggleConnection').textContent='연결 관리 펼치기';$('settingsPanel').hidden=true;
    if(!state.selectedCohort || !cohorts.some(c=>c.date===state.selectedCohort))state.selectedCohort=latest?.date||'';
    if(!findStock(state.selectedKey))state.selectedKey='';
    renderAll();
  }
  function currentCohort(){return state.model?.cohorts.find(x=>x.date===state.selectedCohort)||state.model?.cohorts.at(-1)||null}
  function currentStocks(){return currentCohort()?.stocks||[]}
  function findStock(key){if(!key)return null;return currentStocks().find(x=>x.date+'|'+x.code===key)||null}
  function chosen(){return findStock(state.selectedKey)||currentStocks()[0]||null}
  function resultType(r){const s=String(r?.['Final Result']||'PENDING').toUpperCase();return ['SUCCESS','FAIL','TRACKING','PENDING'].includes(s)?s:'PENDING'}
  // Only fields whose meaning was verified in the selection-time score snapshot.
  // No official composite score is present in the investigated sources.
  const SCORE_FIELDS=Object.freeze({total:null,chart:'chart_technical_score_100',momentum:'momentum_score_100',light:'light_rank_score'});
  function scoreKey(date,cohort,id){return `${date}|${cohort}|${code(id)}`}
  function scoreIndex(file){
    const index=new Map();
    for(const snapshot of file?.snapshots||[]){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.selection_date||'') || !snapshot.cohort_id)continue;
      for(const row of snapshot.records||[]){
        if(!/^\d{6}$/.test(code(row.stock_code)))continue;
        const key=scoreKey(snapshot.selection_date,snapshot.cohort_id,row.stock_code);
        let issue='';
        if(snapshot.source_hash_reference_matches===false)issue='스냅샷 원천 해시 확인 실패';
        if((row.selection_date && row.selection_date!==snapshot.selection_date) || (row.cohort_id && row.cohort_id!==snapshot.cohort_id))issue='스냅샷 내부 선정일·코호트 불일치';
        const entry={...row,selection_date:snapshot.selection_date,cohort_id:snapshot.cohort_id,__issue:issue};
        index.set(key,index.has(key)?{__issue:'동일 코호트·종목 점수 중복'}:entry);
      }
    }
    return index;
  }
  function scoreMismatch(row,cohort,stock){
    if(!row)return state.files.scoreSnapshot?'해당 선정일·코호트·종목의 점수 원천 없음':'선정 점수 스냅샷 미연결';
    if(row.__issue)return row.__issue;
    if(cohort.MORNING_PACK_SHA256 && row.source_pack_declared_sha256!==cohort.MORNING_PACK_SHA256)return '공식 LOCK의 참조팩 해시와 점수 원천 불일치';
    if(row.scoring_model && cohort.model_version && row.scoring_model!==cohort.model_version)return '선정 점수 모델 불일치';
    if(row.selection_rank!==undefined && Number(row.selection_rank)!==Number(stock.rank||stock['Selection Rank']))return '공식 선정 순위와 점수 레코드 불일치';
    if(row.selection_reason_as_locked!==undefined && row.selection_reason_as_locked!==(stock.Selection_Reason||''))return '공식 선정 이유와 점수 레코드 불일치';
    return '';
  }
  function knownScore(s,n){
    const value=s?.scores?.[n];
    if(!['number','string'].includes(typeof value) || (typeof value==='string' && !value.trim()))return null;
    const score=num(value);return score!==null && score>=0 && score<=100?score:null;
  }
  function scoreValue(s,kind){return SCORE_FIELDS[kind]?knownScore(s.score,SCORE_FIELDS[kind]):null}
  function scoreText(s,kind){const value=scoreValue(s,kind);return value===null?'미수집':fixed(value,2)}
  function scoreNote(s){return s.scoreIssue || `선정 점수 스냅샷 · ${s.cohortId} · 점수 기준 ${fmtDay(s.score?.score_data_as_of)}`}
  function finalRate(rows){const complete=rows.filter(r=>['SUCCESS','FAIL'].includes(resultType(r)) && String(r.Status||'').toUpperCase()==='CLOSED');const win=complete.filter(r=>resultType(r)==='SUCCESS').length;return {total:complete.length,win,rate:complete.length?100*win/complete.length:null}}
  function summary(){
    const m=state.model;
    const stat=(title,value,desc,icon,vals)=>`<article class="card kpi"><div class="kpi-name"><em>${icon}</em>${h(title)}</div><div class="kpi-value">${h(value)}</div><div class="kpi-sub">${h(desc)}</div>${vals?.length?'<div class="kpi-graph">'+vals.map(v=>`<i data-bar="${Math.max(5,Math.min(100,Number(v)||0))}"></i>`).join('')+'</div>':''}</article>`;
    if(!m){$('summary').innerHTML=[stat('Hunter 확정 성공률','—','공식 검증 MASTER 필요','◎'),stat('종합점수','미수집','공식 종합점수 원천 필드 없음','♜'),stat('DAY별 성공현황','—','검증된 코호트 기록 없음','▥'),stat('ACTIVE 코호트','—','Drive 연결 대기','♧'),stat('TOP5 평균 MFE','—','관측값 없음','↗'),stat('TOP5 평균 MAE','—','관측값 없음','↘'),stat('운영 체크포인트','08:30','15:40 · 16:20 / 주문 0건','▤')].join('');setBars();return}
    const r=finalRate(m.official);const dayCounts=m.cohorts.map(c=>c.stocks.filter(s=>s.record && resultType(s.record)==='SUCCESS').length);
    const activeDates=new Set(m.official.filter(x=>x.Status==='ACTIVE').map(r=>r.__date));
    const top=m.official.filter(r=>String(r.TOP5)==='True'||r.TOP5===true||String(r.TOP5)==='1');
    const mfe=top.map(x=>num(x['MFE %'])).filter(x=>x!==null);const mae=top.map(x=>num(x['MAE %'])).filter(x=>x!==null);
    const avg=arr=>arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:null;
    $('summary').innerHTML=[
      stat('Hunter 확정 성공률',r.rate===null?'미확정':r.rate.toFixed(1)+'%',`새 기준 종료 ${r.total}종 · 성공 ${r.win}종`,'◎'),
      stat('종합점수','미수집','공식 종합점수 원천 필드 없음 · LIGHT와 구분','♜'),
      stat('DAY별 성공현황',`${m.cohorts.length} DAY`,`실제 관측 성공 ${m.official.filter(x=>resultType(x)==='SUCCESS').length}종 · 확정과 구분`,'▥',dayCounts.map(x=>x/30*100)),
      stat('ACTIVE 코호트',String(activeDates.size),`공식 새 기준 ${m.official.length}종 · LEGACY ${m.legacy.length}종`,'♧'),
      stat('TOP5 평균 MFE',avg(mfe)===null?'—':pct(avg(mfe)),`새 기준 관측 종목 ${mfe.length}개 · 최종수익률 아님`,'↗'),
      stat('TOP5 평균 MAE',avg(mae)===null?'—':pct(avg(mae)),`새 기준 관측 종목 ${mae.length}개`,'↘'),
      stat('운영 체크포인트',fmtDay(m.pointer.as_of),`MASTER ${m.db.length}건 · ${m.pointer.validation_status} · 정규 15:40`,'▤')
    ].join('');setBars();
  }
  function setBars(){document.querySelectorAll('[data-bar]').forEach(el=>{const p=Math.max(5,Math.min(100,Number(el.dataset.bar)||5));el.style.height=p+'%'})}
  function statusBadge(s){let name=statusText[s]||statusText.WAIT;return `<span class="status ${s==='SUCCESS'?'success':s==='FAIL'?'fail':s==='TRACKING'?'track':'wait'}">${h(name)}</span>`}
  function stockKey(s){return s.date+'|'+s.code}
  function valueOf(s,field){return s.record?.[field]}
  function shownStocks(){let arr=currentStocks().filter(s=>{
    if(state.filter==='top5'&&!s.top5)return false;
    if(state.filter==='success'&&resultType(s.record)!=='SUCCESS')return false;
    if(state.filter==='pending'&&s.record)return false;
    const q=state.search;
    return !q || `${s.name} ${s.code} ${s.reason}`.toLowerCase().includes(q);
  });
    const n=s=>state.sort==='mfe'?num(valueOf(s,'MFE %')):scoreValue(s,state.sort);
    if(state.sort==='rank')arr=arr.sort((a,b)=>a.rank-b.rank);else arr=arr.sort((a,b)=>(n(b)??-1e9)-(n(a)??-1e9)||a.rank-b.rank);
    return arr;
  }
  function renderFilters(){const ss=currentStocks();const items=[['all',`전체 (${ss.length})`],['top5',`TOP5 (${ss.filter(s=>s.top5).length})`],['success',`관측 SUCCESS (${ss.filter(s=>resultType(s.record)==='SUCCESS').length})`],['pending',`MASTER 미반영 (${ss.filter(s=>!s.record).length})`]];
    $('filters').innerHTML=items.map(([id,label])=>`<button type="button" data-filter="${id}" class="${state.filter===id?'active':''}">${h(label)}</button>`).join('');
  }
  function renderContent(){
    renderFilters();const m=state.model;
    if(!m){$('content').innerHTML=`<div class="empty"><strong>비공개 MASTER 연결 대기</strong>로그인 후 처음 한 번만 MASTER 파일 연결을 승인해 주세요. 이후에는 자동 복원을 시도합니다.<br>로컬 JSON을 선택해도 데이터는 브라우저 밖으로 전송되지 않습니다.</div>`;return}
    if(state.tab==='stocks')return renderStocks();
    if(state.tab==='reasons')return renderReasons();
    if(state.tab==='top5')return renderTop5();
    if(state.tab==='days')return renderDays();
    if(state.tab==='learning')return renderLearning();
  }
  function renderStocks(){const list=shownStocks();$('content').innerHTML=`<div class="data-wrap"><table class="stock-table"><thead><tr><th>순위</th><th>종목명 · 코드</th><th>검증 종가</th><th>+3% 목표</th><th>Hunter</th><th>종합점수</th><th>차트·기술</th><th>모멘텀</th><th>LIGHT 점수</th><th>MFE</th><th>MAE</th><th>코호트</th></tr></thead><tbody>${list.map(s=>{
    const r=s.record;const re=r?resultType(r):'WAIT';return `<tr tabindex="0" data-select="${h(stockKey(s))}" class="${chosen()&&stockKey(chosen())===stockKey(s)?'selected':''}"><td>${h(s.rank)}</td><td><span class="stock-name">${h(s.name)}</span><span class="stock-code">${h(s.code)}${s.top5?' · TOP5':''}</span></td><td>${h(money(r?.Close))}</td><td>${h(money(r?.['+3% Target']))}</td><td>${statusBadge(re)}</td>${['total','chart','momentum','light'].map(kind=>`<td class="score" title="${h(kind==='total'?'공식 종합점수 원천 필드 없음':scoreNote(s))}">${h(scoreText(s,kind))}</td>`).join('')}<td class="positive">${h(pct(r?.['MFE %']))}</td><td class="negative">${h(pct(r?.['MAE %']))}</td><td>${h(s.date.slice(5))}</td></tr>`}).join('')||`<tr><td colspan="12" class="empty">조건에 맞는 종목이 없습니다.</td></tr>`}</tbody></table></div><div class="table-foot">선정일: ${h(fmtDay(currentCohort()?.date))} · 표시 ${list.length}종 · 가격은 실시간이 아닌 MASTER 마지막 검증값 · 종목 선택 시 오른쪽 상세 갱신</div><p class="muted">점수는 별도 LEARNING_SCORE_SNAPSHOT JSON을 보조 데이터에서 선택하면 연결됩니다. 선정일·코호트·종목코드와 LOCK 참조팩이 일치하는 값만 표시합니다. 종합점수는 미수집이며 LIGHT는 순위 참고점수입니다.</p>`;
    document.querySelectorAll('tr[data-select]').forEach(row=>row.addEventListener('keydown',e=>{if(e.key==='Enter'){state.selectedKey=row.dataset.select;renderAll()}}));
  }
  function renderReasons(){const list=shownStocks();$('content').innerHTML=`<p class="muted">공식 LOCK의 선정 당시 원문을 표시합니다. 후일의 주가·뉴스를 선정 이유에 소급 반영하지 않습니다.</p>${list.map(s=>`<button class="reason-card" type="button" data-select="${h(stockKey(s))}"><b>${s.rank}. ${h(s.name)} ${s.top5?'<span class="status track">TOP5</span>':''}</b><p>${h(s.reason||'공식 선정 이유 기록 없음')}</p></button>`).join('')||'<div class="empty">선정 이유 자료가 없습니다.</div>'}`}
  function renderTop5(){let list=shownStocks().filter(s=>s.top5);$('content').innerHTML=`<p class="muted">해당 DAY의 공식 TOP5. 이후 성과는 검증된 MASTER 결과가 있는 경우에만 표기합니다.</p>${list.map(s=>`<button class="reason-card" type="button" data-select="${h(stockKey(s))}"><b>${h(s.rank)} · ${h(s.name)} (${h(s.code)}) ${statusBadge(s.record?resultType(s.record):'WAIT')}</b><p>${h(s.reason||'선정 이유 없음')}</p><p>MFE: ${h(pct(s.record?.['MFE %']))}　MAE: ${h(pct(s.record?.['MAE %']))}　최초 도달: ${h(s.record?.['First Hit D+']||'—')}</p></button>`).join('')||'<div class="empty">TOP5 기록이 없습니다.</div>'}`}
  function renderDays(){let m=state.model;
    const cards=[...m.cohorts].reverse().map(c=>{
      const rs=c.stocks.map(x=>x.record).filter(Boolean);const seen=rs.filter(x=>resultType(x)==='SUCCESS').length;const f=rs.filter(x=>x.Status==='CLOSED'&&resultType(x)==='FAIL').length;const pending=c.stocks.filter(x=>!x.record).length;
      return `<button class="day-card ${c.date===state.selectedCohort?'active':''}" type="button" data-cohort="${h(c.date)}"><small>${h(c.cohortId)}</small><b>${h(c.date)}</b><div class="positive">관측 성공 ${seen}종</div><div class="negative">확정 실패 ${f}종</div><small>성과 미반영 ${pending}종 · 선정 ${c.stocks.length}종</small></button>`;
    });
    $('content').innerHTML=`<p class="muted">공식 코호트별 검증 현황. D+5 미종료의 TRACKING을 실패에 포함하지 않음. 새 기준과 LEGACY_REFERENCE 통계는 합산하지 않음.</p><div class="day-grid">${cards.join('')}</div><div class="reason-card" style="cursor:default;margin-top:18px"><b>LEGACY_REFERENCE (별도 참고 통계)</b><p>기록 ${m.legacy.length}종 · 새 기준 헌터 성공률에 미포함</p><b>공식 NEW_20261008</b><p>기록 ${m.official.length}종 · MASTER ${h(m.pointer.as_of)} 기준</p></div>`;
  }
  function renderLearning(){const m=state.model;const sc=currentStocks().filter(x=>x.score);const vals=k=>sc.map(s=>knownScore(s.score,k)).filter(n=>n!==null);const avg=a=>a.length?(a.reduce((x,y)=>x+y,0)/a.length).toFixed(1):'미수집';
    const kinds=[['공식 종합점수',null],['LIGHT 순위 참고점수','light_rank_score'],['차트·기술 점수','chart_technical_score_100'],['모멘텀 점수','momentum_score_100'],['거래량 점수','volume_score_100'],['캔들 점수','candle_score_100'],['종가 위치','close_position_score_100'],['돌파 위치','breakout_position_score_100'],['세션 강도','session_strength_score_100']];
    $('content').innerHTML=`<p class="muted">선정 시점 점수만 표시합니다. 점수 스냅샷을 선택하지 않았거나 원자료에 없는 항목은 0으로 채우지 않습니다.</p><div class="learning-grid">${kinds.map(([label,key])=>`<article class="learning-card"><h3>${h(label)}</h3><strong>${h(avg(vals(key)))}</strong><p>데이터 ${vals(key).length}/${currentStocks().length}종 · 선정 당시 원자료 기준</p></article>`).join('')}</div><div class="reason-card" style="cursor:default;margin-top:15px"><b>원천에 없는 점수 항목</b><p>독립 추세 · 패턴 · 타이밍 · 수급 · 뉴스 점수는 원자료에 없다면 미측정으로 표시. 기존 점수 산식·가중치를 임의 변경하지 않음.</p></div>`;
  }
  function renderDetail(){const s=chosen();if(!s){$('detail').innerHTML='<h2>종목 상세</h2><p class="muted">검증된 MASTER 데이터와 공식 30종이 연결되면 차트·선정 이유를 표시합니다.</p>';return}
    const r=s.record;const prices=[];for(let i=1;i<=5;i++){const close=num(r?.[`D+${i} Close`]);const day=r?.[`D+${i} Date`];if(close!==null && day)prices.push({v:close,day})}
    const chart=prices.length?lineChart(prices):'<div class="empty" style="padding:35px 4px">검증된 D+1~D+5 일별 종가 없음<br>키움 WebSocket 실시간 차트는 이후 단계</div>';
    const reasons=String(s.reason||'선정 이유 미기록').split(/;\s*/).filter(Boolean);
    $('detail').innerHTML=`<h2>${h(s.name)}</h2><div class="sub">${h(s.code)} · ${h(s.date)} 공식 LOCK ${s.top5?'· TOP5':''}</div><div class="detail-price">${h(money(r?.Close))}</div><small>마지막 검증 종가 · 실시간 시세 아님</small><div class="chartbox">${chart}<div class="chart-note">${prices.length?'MASTER D+1~D+5 검증 종가만 연결됨':'미관측 / 미검증 데이터는 표시하지 않음'}</div></div><div class="detail-h">3% Hunter 관측</div><div class="reason-list"><li>판정: ${r?statusBadge(resultType(r)):'MASTER 성과 미반영'}</li><li>기준 D+1 시초가: <strong>${h(money(r?.['Reference Open']))}</strong>　목표: <strong>${h(money(r?.['+3% Target']))}</strong></li><li>MFE <strong class="positive">${h(pct(r?.['MFE %']))}</strong> · MAE <strong class="negative">${h(pct(r?.['MAE %']))}</strong></li><li>최초 +3% 도달일: <strong>${h(r?.['First Hit D+']||'—')}</strong></li></div><div class="detail-h">왜 선정했을까?</div><ol class="reason-list">${reasons.map((x,i)=>`<li><strong>${i+1}.</strong> ${h(x)}</li>`).join('')||'<li>선정 이유 미기록</li>'}</ol><div class="detail-h">선정시점 점수</div><div class="reason-list"><li>종합점수: <strong>${h(scoreText(s,'total'))}</strong> · 공식 종합점수 원천 필드 없음</li><li>차트·기술: <strong>${h(scoreText(s,'chart'))}</strong> / 모멘텀: <strong>${h(scoreText(s,'momentum'))}</strong></li><li>LIGHT 순위 참고점수: <strong>${h(scoreText(s,'light'))}</strong></li><li>${h(scoreNote(s))}</li><li>원자료 없는 점수는 미수집 · 선정 이유의 점수 표현은 LOCK 원문 그대로 보존</li></div>`;
  }
  function lineChart(prices){
    const values=prices.map(p=>p.v);const lo=Math.min(...values),hi=Math.max(...values),span=Math.max(1,hi-lo);
    const xy=prices.map((p,i)=>({x:30+i*(250/Math.max(1,prices.length-1)),y:132-(p.v-lo)/span*95,day:p.day,v:p.v}));
    const poly=xy.map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 310 165" role="img" aria-label="검증 일별 종가 추세"><line x1="25" y1="30" x2="290" y2="30" stroke="#263b55"/><line x1="25" y1="84" x2="290" y2="84" stroke="#263b55"/><line x1="25" y1="137" x2="290" y2="137" stroke="#263b55"/><polyline points="${poly}" fill="none" stroke="#4897ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${xy.map(p=>`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="#6cb4ff"/>`).join('')}<text x="20" y="17" fill="#8db2d7" font-size="10">${h(comma(hi))}</text><text x="20" y="155" fill="#8db2d7" font-size="10">${h(comma(lo))}</text></svg>`;
  }
  function renderAll(){
    $('dashboardBody').hidden=!state.model;
    document.querySelectorAll('#tabs [data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===state.tab));
    summary();renderContent();renderDetail();
    const m=state.model;
    $('footerState').textContent=m?`검증 MASTER ${m.pointer.as_of} · ${m.db.length}종목 기록 · ${state.mode==='drive'?'Google Drive':'로컬 미리보기'}`:'MASTER 미연결 · 실시간 API 미연결';
  }
  document.addEventListener('DOMContentLoaded',bootstrap);
})();

