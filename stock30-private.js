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
  const SCORE_FOLDER_ID = '13HZpgafKCULsHkKfnhGiohUWbgDzGOXV';
  const SCORE_FILENAME = /^Stock30_LEARNING_SCORE_SNAPSHOT_.*\.json$/;
  const SCORE_DEFINITIONS = Object.freeze({chart_technical_score_100:'score',momentum_score_100:'short_momentum',volume_score_100:'relative_volume',candle_score_100:'candle_strength',close_position_score_100:'close_position',breakout_position_score_100:'breakout_position',session_strength_score_100:'session_strength'});
  const newScoreSession = () => ({cache:new Map(),documents:[],scanDocuments:null,folderOK:false,inflight:null,lastScan:0,checkedAt:'',status:'미연결',message:'MASTER 연결 후 허용된 점수 스냅샷을 확인합니다.'});
  let scoreSession = newScoreSession();
  let masterRequest = 0;
  let pendingPointer = null;
  let tokenClient = null;
  let tokenExpiry = 0;
  const safeError = e => {
    const raw = String(e && e.message || e || '알 수 없는 오류');
    // Never leak bearer tokens, Google API keys or large provider response payloads to page/log.
    return raw.slice(0,250).replace(/ya29\.[a-z0-9._-]+/gi,'[REDACTED]').replace(/AIza[\w-]{20,}/g,'[REDACTED]');
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
    $('retryScoresBtn').addEventListener('click',()=>connectScores(true));
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
    const r=await fetch(url,{headers:{Authorization:`Bearer ${state.token}`},cache:'no-store',redirect:'error',signal:typeof AbortSignal!=='undefined'?AbortSignal.timeout(15000):undefined});
    if(!r.ok){const error=Error(`Google API HTTP ${r.status}${r.status===403?' (권한 또는 API 설정 확인)':''}${r.status===404?' (파일 접근 권한/선택 여부 확인)':''}`);error.status=r.status;throw error;}
    try{return await r.json()}catch(_){throw Error('Google 파일 JSON 형식 확인 필요');}
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
    const session=scoreSession;
    try{
      status(`${name||'선택한 파일'} 읽는 중...`);
      const snapshot=kind==='extra' && SCORE_FILENAME.test(name||'');
      const document=snapshot?await readScoreFile(await scoreMetadata(id),session):null;
      const json=document?.data||await authFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
      ensureSession(session);
      const inferred=detectType(json);
      if(kind!=='extra' && inferred!==kind)throw Error('선택한 파일 형식을 확인해 주세요.');
      if(kind==='extra' && !['lock','scoreSnapshot'].includes(inferred))throw Error('공식 LOCK 또는 학습 점수 JSON을 선택해 주세요.');
      const type=kind==='extra'?inferred:kind;
      if(type==='masterPointer' && name && name!=='master_current.json')throw Error('포인터 파일명이 master_current.json이 아닙니다.');
      if(type==='masterPointer' && state.model && json.generation!==state.model.pointer.generation){
        pendingPointer={data:json,id};status('새 MASTER 포인터 확인 · 검증 생성본을 선택해 주세요. 기존 화면은 유지됩니다.');return;
      }
      const files={...state.files,[type]:json},ids={...state.fileIds,[type]:id};
      if(type==='generation' && pendingPointer){files.masterPointer=pendingPointer.data;ids.masterPointer=pendingPointer.id;}
      const documents=document?session.documents.map(d=>d.id===id?document:d):session.documents;
      if(!files.masterPointer || !files.generation){state.files=files;state.fileIds=ids;state.mode='drive';assemble();rememberFiles();updateConnection();status('MASTER 포인터·검증 생성본을 모두 선택해 주세요.');return;}
      await connectScores(false,{files,ids,mode:'drive',documents});
      if(state.files.generation===json)pendingPointer=null;
      status('파일 연결 확인 완료 · 점수 연결 상태를 확인해 주세요.');
    }catch(e){if(session===scoreSession){showError('Drive 파일 조회',e);renderAll();}}
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
    const session=scoreSession;
    let cached=null;
    try{cached=JSON.parse(localStorage.getItem(FILE_CACHE_KEY)||'null')}catch(_){}
    if(!cached || cached.email!==state.email || !cached.ids?.masterPointer){status('Google 로그인 완료 · MASTER 포인터와 검증 생성본을 선택해 주세요.');return;}
    const fetchId=id=>authFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
    const pointer=await fetchId(cached.ids.masterPointer);ensureSession(session);
    if(detectType(pointer)!=='masterPointer' || pointer.validation_status!=='PASS' || !/^[A-Za-z0-9_-]{10,}$/.test(pointer.location||''))throw Error('저장된 MASTER 포인터 확인 필요');
    const generation=await fetchId(pointer.location);ensureSession(session);
    const files={...EMPTY,masterPointer:pointer,generation},ids={masterPointer:cached.ids.masterPointer,generation:pointer.location};
    for(const type of ['lock','scoreSnapshot']){
      const id=cached.ids[type];if(!id)continue;
      try{
        const extra=type==='scoreSnapshot'?(await readScoreFile(await scoreMetadata(id),session)).data:await fetchId(id);
        ensureSession(session);if(detectType(extra)===type){files[type]=extra;ids[type]=id;}
      }catch(_){ensureSession(session);/* Optional files never prevent a read-only MASTER view. */}
    }
    await connectScores(false,{files,ids,mode:'drive'});
    status('MASTER 자동 연결 확인 완료 · 점수 연결 상태를 확인해 주세요.');
  }

  // Read-only latest pointer check. Never overwrite the displayed model until full validation passes.
  // Google drive.file may require a one-time Picker grant for each newly published generation.
  async function refreshCurrentMaster(manual=false){
    if(state.refreshing)return;
    if(!state.token || Date.now()>=tokenExpiry){if(manual)status('Google 로그인이 만료됐습니다. 다시 로그인해 주세요.',true);return;}
    if(!state.fileIds.masterPointer){if(manual)status('MASTER 포인터부터 선택해 주세요.',true);return;}
    const session=scoreSession;state.refreshing=true;
    try{
      const pointer=await authFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(state.fileIds.masterPointer)}?alt=media`);ensureSession(session);
      if(detectType(pointer)!=='masterPointer' || pointer.validation_status!=='PASS')throw Error('최신 포인터 검증 PASS가 아닙니다.');
      if(!/^[A-Za-z0-9_-]{10,}$/.test(pointer.location||''))throw Error('generation 파일 ID 확인 필요');
      const generation=state.model?.pointer.generation===pointer.generation?state.files.generation:await authFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(pointer.location)}?alt=media`);ensureSession(session);
      await connectScores(manual,{files:{...state.files,masterPointer:pointer,generation},ids:{...state.fileIds,generation:pointer.location},mode:'drive'});
      status('MASTER·점수 연결 확인 완료 · 연결 보류 시 기존 정상 화면 유지');
    }catch(e){if(session===scoreSession){status(`최신 MASTER 확인 실패: ${safeError(e)} · 기존 화면 유지`,true);}}
    finally{if(session===scoreSession)state.refreshing=false;}
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
  function clearData(){scoreSession=newScoreSession();masterRequest++;pendingPointer=null;state.refreshing=false;state.files={...EMPTY};state.fileIds={};state.model=null;state.selectedKey='';state.selectedCohort='';state.mode='none';renderAll();updateConnection()}
  function safeParse(s,name){try{return JSON.parse(s)}catch(_){throw Error(`${name} 내부 JSON 파싱 실패`)}}
  function scoreDocuments(files=state.files,ids=state.fileIds,documents=scoreSession.documents){
    const result=[...documents];
    if(files.scoreSnapshot && !result.some(d=>ids.scoreSnapshot && d.id===ids.scoreSnapshot))result.push({id:ids.scoreSnapshot||'manual-local',name:scoreSession.cache.get(ids.scoreSnapshot)?.name||'수동 점수 스냅샷',mode:'manual',data:files.scoreSnapshot});
    return result;
  }
  function ensureSession(session){if(session!==scoreSession)throw Error('연결 세션 변경');}
  async function scoreMetadata(id){return authFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,version,size,modifiedTime&supportsAllDrives=true`);}
  async function readScoreFile(meta,session=scoreSession){
    ensureSession(session);
    const version=String(meta.version||meta.modifiedTime||'');
    if(!version || Number(meta.size)>15*1024*1024)throw Error('점수 파일 메타데이터 또는 크기 확인 필요');
    const cached=session.cache.get(meta.id);
    if(cached?.version===version)return cached;
    const data=await authFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(meta.id)}?alt=media`);
    ensureSession(session);
    const after=await scoreMetadata(meta.id);ensureSession(session);
    if(String(after.version||after.modifiedTime||'')!==version)throw Error('점수 업로드 진행 중');
    if(detectType(data)!=='scoreSnapshot' || data.snapshots.some(s=>!s || !Array.isArray(s.records) || s.records.some(r=>!r || typeof r!=='object')))throw Error('점수 파일 업로드 또는 형식 확인 필요');
    const document={id:meta.id,name:meta.name,version,mode:'auto',data};
    session.cache.set(meta.id,document);return document;
  }
  async function scanScoreFiles(force=false){
    const session=scoreSession;
    if(session.inflight)return session.inflight;
    if(!force && session.lastScan && Date.now()-session.lastScan<60000)return session.scanDocuments||session.documents;
    session.inflight=(async()=>{
      if(!session.folderOK){
        const folder=await authFetch(`https://www.googleapis.com/drive/v3/files/${SCORE_FOLDER_ID}?fields=id,mimeType&supportsAllDrives=true`);ensureSession(session);
        if(folder.mimeType!=='application/vnd.google-apps.folder')throw Error('점수 폴더 확인 필요');
        session.folderOK=true;
      }
      const metadata=[];let pageToken='';
      for(let page=0;page<3;page++){
        const params=new URLSearchParams({q:`'${SCORE_FOLDER_ID}' in parents and trashed = false and name contains 'Stock30_LEARNING_SCORE_SNAPSHOT_'`,fields:'nextPageToken,incompleteSearch,files(id,name,version,size,modifiedTime)',pageSize:'50',spaces:'drive',supportsAllDrives:'true',includeItemsFromAllDrives:'true'});
        if(pageToken)params.set('pageToken',pageToken);
        const listed=await authFetch(`https://www.googleapis.com/drive/v3/files?${params}`);ensureSession(session);
        if(listed.incompleteSearch || !Array.isArray(listed.files))throw Error('점수 폴더 조회 미완료');
        metadata.push(...listed.files.filter(f=>SCORE_FILENAME.test(f.name||'')));
        pageToken=listed.nextPageToken||'';if(!pageToken)break;
      }
      if(pageToken || metadata.length>40)throw Error('점수 파일 조회 한도 초과 · 수동 선택 필요');
      const unique=new Map();
      for(const meta of metadata){if(unique.has(meta.id) && JSON.stringify(unique.get(meta.id))!==JSON.stringify(meta))throw Error('조회 중 파일 메타데이터 변경');unique.set(meta.id,meta);}
      const documents=[];
      for(const meta of unique.values()){ensureSession(session);documents.push(await readScoreFile(meta,session));}
      ensureSession(session);session.lastScan=Date.now();session.scanDocuments=documents;return documents;
    })();
    try{return await session.inflight}finally{session.inflight=null}
  }
  function previewModel(files,ids,documents){
    const previous={files:state.files,ids:state.fileIds,model:state.model,cohort:state.selectedCohort,key:state.selectedKey,documents:scoreSession.documents};
    try{state.files=files;state.fileIds=ids;scoreSession.documents=documents;assemble(false);return state.model}
    finally{state.files=previous.files;state.fileIds=previous.ids;state.model=previous.model;state.selectedCohort=previous.cohort;state.selectedKey=previous.key;scoreSession.documents=previous.documents;}
  }
  function scoreRegression(previous,next){
    if(!previous)return '';
    for(const cohort of previous.cohorts){
      const target=next.cohorts.find(c=>c.date===cohort.date && c.cohortId===cohort.cohortId);
      if(!target)return '기존 공식 코호트가 새 MASTER에 없음';
      for(const stock of cohort.stocks){
        if(!stock.score)continue;
        const candidate=target.stocks.find(s=>s.code===stock.code);
        if(!candidate?.score)return candidate?.scoreIssue||'기존 점수 연결 누락';
        const fields=[...Object.keys(SCORE_DEFINITIONS),'light_rank_score'];
        if(stock.score.source_pack_declared_sha256!==candidate.score.source_pack_declared_sha256 || fields.some(k=>stock.score.scores?.[k]!==candidate.score.scores?.[k]))return '기존 정상 점수와 새 점수 충돌';
      }
    }
    return '';
  }
  function setScoreStatus(status,message){scoreSession.status=status;scoreSession.message=message;renderScoreConnection();}
  function scoreFailure(error){
    if(error?.status===403 || error?.status===404)return '폴더 또는 점수 파일 조회 권한 부족 · 권한을 확대하지 않습니다. 보조 데이터에서 수동 선택해 주세요.';
    if(error?.status===401 || !state.token)return 'Google 인증 확인 필요 · 다시 로그인해 주세요.';
    return '점수 자동 연결 실패 또는 부분 업로드 · 기존 정상 데이터 유지 · 잠시 후 재시도해 주세요.';
  }
  async function connectScores(force=false,proposal=null){
    const session=scoreSession,request=++masterRequest;
    const files=proposal?.files||state.files,ids=proposal?.ids||state.fileIds,mode=proposal?.mode||state.mode;
    if(!files.masterPointer || !files.generation)return;
    let documents=proposal?.documents||session.documents,error=null;
    previewModel(files,ids,documents); // Validate MASTER before any score requests.
    if(mode==='drive' && state.token){
      setScoreStatus('확인 중','허용된 점수 파일의 연결 상태를 확인하고 있습니다.');
      try{documents=await scanScoreFiles(force)}catch(e){error=e;}
    }
    if(session!==scoreSession || request!==masterRequest)return;
    session.checkedAt=new Date().toISOString();
    const candidate=previewModel(files,ids,documents);
    let issue=scoreRegression(state.model,candidate);
    if(state.model && state.model.pointer.generation!==candidate.pointer.generation){
      const before=new Set(state.model.master.locked_selections.map(c=>c.selection_date+'|'+c.cohort_id));
      const newCohorts=candidate.master.locked_selections.filter(c=>!before.has(c.selection_date+'|'+c.cohort_id));
      for(const c of newCohorts){const rows=candidate.cohorts.find(x=>x.date===c.selection_date && x.cohortId===c.cohort_id)?.stocks||[];if(rows.length!==30 || rows.some(s=>!s.score))issue='새 공식 MASTER의 점수 스냅샷 준비 대기';}
    }
    if(issue){setScoreStatus(/해시/.test(issue)?'해시 불일치':'연결 보류',`${issue} · 기존 정상 데이터 유지`);return;}
    state.files=files;state.fileIds=ids;state.mode=mode;session.documents=documents;
    assemble();rememberFiles();updateConnection();
    const relevant=state.model.cohorts.flatMap(c=>c.stocks);
    const invalid=relevant.find(s=>s.scoreIssue && !/미연결|원천 없음|MASTER에 없는/.test(s.scoreIssue));
    const count=relevant.filter(s=>s.score).length;
    if(error)setScoreStatus('자동 미연결',scoreFailure(error)+(count?' · 기존 또는 수동 연결 유지':''));
    else if(invalid)setScoreStatus(/해시/.test(invalid.scoreIssue)?'해시 불일치':'검증 불일치',`${invalid.scoreIssue} · 해당 값은 미수집`);
    else setScoreStatus(count?(relevant.some(s=>s.score?.__mode==='auto')?'자동 연결 성공':'수동 연결 · 자동 미연결'):'미연결',count?`MASTER에 포함된 ${count}건 연결 · 조회에서 보이지 않는 파일은 수동 선택이 필요할 수 있습니다.`:'허용된 조회 결과에 해당 코호트 점수 없음 · 보조 데이터에서 수동 선택해 주세요.');
  }
  function renderScoreConnection(){
    if(!$('scoreConnectionStatus'))return;
    $('scoreConnectionStatus').textContent=`점수 ${scoreSession.status}`;
    $('scoreConnectionMessage').textContent=scoreSession.message;
    const connected=(state.model?.cohorts||[]).filter(c=>c.stocks.some(s=>s.score));
    $('scoreConnectedCohorts').textContent=connected.length?connected.map(c=>`${c.date} / ${c.cohortId} (${c.stocks.filter(s=>s.score).length}/${c.stocks.length}건) · ${[...new Set(c.stocks.filter(s=>s.score).map(s=>s.score.__source))].join(', ')}`).join(' · '):'연결 코호트 없음';
    $('scoreConnectionChecked').textContent='마지막 연결 확인: '+(scoreSession.checkedAt?new Date(scoreSession.checkedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})+' KST':'—');
    $('retryScoresBtn').disabled=!state.token || state.mode!=='drive' || scoreSession.status==='확인 중';
  }

  function assemble(render=true){
    const p=state.files.masterPointer,g=state.files.generation;
    if(!p||!g){state.model=null;if(render)renderAll();return}
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
    const scores=scoreIndex(scoreDocuments(),registered);
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
    if(render){$('workflowSection').classList.add('compact');$('toggleConnection').textContent='연결 관리 펼치기';$('settingsPanel').hidden=true;}
    if(!state.selectedCohort || !cohorts.some(c=>c.date===state.selectedCohort))state.selectedCohort=latest?.date||'';
    if(!findStock(state.selectedKey))state.selectedKey='';
    if(render)renderAll();
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
  function scoreIndex(documents,cohorts=[]){
    const index=new Map();
    const allowed=new Map(cohorts.map(c=>[c.selection_date+'|'+c.cohort_id,c]));
    for(const document of documents){
      const file=document.data;
      const definitionsOK=Object.entries(SCORE_DEFINITIONS).every(([key,value])=>file.score_definitions?.[key]===value);
      for(const snapshot of file.snapshots||[]){
        if(!snapshot || typeof snapshot!=='object')continue;
        const cohort=allowed.get(snapshot.selection_date+'|'+snapshot.cohort_id);if(!cohort)continue;
        let issue=definitionsOK?'':'점수 필드 정의 불일치';
        const records=Array.isArray(snapshot.records)?snapshot.records:[];
        const expected=new Set(cohort.stocks.map(s=>code(s.stock_code)));
        if(records.length!==expected.size || (snapshot.record_count!==undefined && snapshot.record_count!==records.length))issue='점수 코호트 부분 업로드 또는 건수 불일치';
        if(snapshot.source_hash_reference_matches===false)issue='스냅샷 원천 해시 확인 실패';
        const codes=new Set();
        for(const row of records){
          const raw=row?.stock_code;
          if(!((typeof raw==='string' && /^\d{1,6}$/.test(raw)) || (Number.isInteger(raw) && raw>=0 && raw<=999999)) || !expected.has(code(raw)))issue='점수 종목코드 불일치';
          if(codes.has(code(raw)))issue='동일 코호트·종목 점수 중복';codes.add(code(raw));
          if((row?.selection_date && row.selection_date!==snapshot.selection_date) || (row?.cohort_id && row.cohort_id!==snapshot.cohort_id))issue='스냅샷 내부 선정일·코호트 불일치';
        }
        for(const stock of cohort.stocks){
          const key=scoreKey(snapshot.selection_date,snapshot.cohort_id,stock.stock_code);
          const row=records.find(r=>code(r?.stock_code)===code(stock.stock_code));
          const entry={...row,selection_date:snapshot.selection_date,cohort_id:snapshot.cohort_id,__issue:issue,__source:document.name,__mode:document.mode||'manual'};
          if(index.has(key)){
            const previous=index.get(key);
            index.set(key,{__issue:previous.source_pack_declared_sha256!==entry.source_pack_declared_sha256?'스냅샷 간 원천 참조 해시 충돌':'이전 스냅샷과 코호트·종목 중복'});
          }else index.set(key,entry);
        }
      }
    }
    return index;
  }
  function scoreMismatch(row,cohort,stock){
    if(!row)return (state.files.scoreSnapshot || scoreSession.documents.length)?'해당 선정일·코호트·종목의 점수 원천 없음':'선정 점수 스냅샷 미연결';
    if(row.__issue)return row.__issue;
    if(!row.scores || typeof row.scores!=='object')return '점수 필드 미수집';
    if(!/^[a-f0-9]{64}$/i.test(cohort.MORNING_PACK_SHA256||''))return '공식 LOCK의 점수 참조 해시 미수집';
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
  function renderLearning(){const m=state.model;const sc=currentStocks().filter(x=>x.score);const vals=k=>k?sc.map(s=>knownScore(s.score,k)).filter(n=>n!==null):[];const avg=a=>a.length?(a.reduce((x,y)=>x+y,0)/a.length).toFixed(1):'미수집';
    const kinds=[['공식 종합점수',null],['LIGHT 순위 참고점수','light_rank_score'],['차트·기술 점수','chart_technical_score_100'],['모멘텀 점수','momentum_score_100'],['거래량 점수','volume_score_100'],['캔들 점수','candle_score_100'],['종가 위치','close_position_score_100'],['돌파 위치','breakout_position_score_100'],['세션 강도','session_strength_score_100']];
    $('content').innerHTML=`<p class="muted">선정 시점 점수만 표시합니다. 점수 스냅샷을 선택하지 않았거나 원자료에 없는 항목은 0으로 채우지 않습니다.</p><div class="learning-grid">${kinds.map(([label,key])=>`<article class="learning-card"><h3>${h(label)}</h3><strong>${h(avg(vals(key)))}</strong><p>데이터 ${vals(key).length}/${currentStocks().length}종 · 선정 당시 원자료 기준</p></article>`).join('')}</div><div class="reason-card" style="cursor:default;margin-top:15px"><b>원천에 없는 점수 항목</b><p>독립 추세 · 패턴 · 타이밍 · 수급 · 뉴스 점수는 원자료에 없다면 미수집으로 표시. 기존 점수 산식·가중치를 임의 변경하지 않음.</p></div>`;
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
    renderScoreConnection();
    $('dashboardBody').hidden=!state.model;
    document.querySelectorAll('#tabs [data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===state.tab));
    summary();renderContent();renderDetail();
    const m=state.model;
    $('footerState').textContent=m?`검증 MASTER ${m.pointer.as_of} · ${m.db.length}종목 기록 · ${state.mode==='drive'?'Google Drive':'로컬 미리보기'}`:'MASTER 미연결 · 실시간 API 미연결';
  }
  document.addEventListener('DOMContentLoaded',bootstrap);
})();

