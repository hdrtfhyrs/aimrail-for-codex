import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../public-paths.mjs";
// Derive current callability from read-only originals, not a second asset registry.
import fs from 'node:fs';
const cleanup=_publicPath("$system/成果/2026-10-02_本地软件与D盘清理");
export const currentEvidenceSources={diagnosis:cleanup+'/Python入口修复/diagnosis-and-validation.json',pythonExplanation:cleanup+'/Python入口修复/Python入口修复结果.md',software:cleanup+'/D盘/三大软件程序文件/三款清后实际路径与保全核验.json',overall:cleanup+'/本次整体清理结果.md',stm32:cleanup+'/软件/stm32-uninstall-run.json',disk:cleanup+'/D盘/D盘清理结果.md'};
const norm=p=>String(p||'').replaceAll('\\','/').toLowerCase();
export function recordProof(state,key,proof){
 state.items||={};state.history||={};const old=state.items[key];
 if(old&&JSON.stringify(old)===JSON.stringify(proof))return;
 if(old){state.history[key]||=[];if(!state.history[key].some(p=>JSON.stringify(p)===JSON.stringify(old)))state.history[key].push(old);}
 state.items[key]=proof;
}
export function applyAvailability(entry,proof){
 if(entry.retired){entry.availability='retired';entry.defaultCallable=false;entry.verification='retired_program_originals_preserved';return entry;}
 if(entry.kind==='runtime'&&entry.name==='python'){
  const codeLayer=proof&&['python_isolated_boot','python_actual_use','python_utf8_readonly'].includes(proof.layer);
  entry.availability=codeLayer?(proof.status==='verified'?'code_verified':'boot_failed'):entry.pathExists?'code_unverified':'path_missing';
  entry.defaultCallable=entry.availability==='code_verified';
  if(codeLayer)entry.verification=proof.status==='verified'?'python_code_verified':'python_boot_failed';
  if(proof?.status==='failed'&&codeLayer)entry.currentIssue=proof.reason||'Python初始化失败；版本回执不证明能执行代码。';
 }
 if(entry.kind==='environment'&&proof){entry.availability=proof.status==='failed'?'boot_failed':'code_verified';entry.defaultCallable=proof.status==='verified';entry.verification=proof.status==='failed'?'python_boot_failed':'python_code_verified';entry.currentIssue=proof.reason||null;}
 return entry;
}
export function syncCurrentEvidence(rows,{id,addRuntime,state,writeState}){
 const s=currentEvidenceSources;if(!fs.existsSync(s.diagnosis)||!fs.existsSync(s.software))return {sources:[],gaps:['最新清理原证未取得，保留原导航边界。']};
 const d=JSON.parse(fs.readFileSync(s.diagnosis,'utf8')),removed=JSON.parse(fs.readFileSync(s.software,'utf8'));
 for(const [field,alias,use]of [['base_isolated_start','runtime:legacy-c312','legacy_base'],['registered_stable_material_query','runtime:stable-python','general_tools'],['pdf_yaml_actual_use','runtime:pdf-yaml','pdf_yaml_tools']]){
  const value=d[field];if(!value?.executable)continue;addRuntime(value.executable,'python',s.diagnosis,use==='general_tools'?'stable-python':use==='pdf_yaml_tools'?'python-tool-support':null);
  const row=rows.find(r=>r.kind==='runtime'&&norm(r.path)===norm(value.executable));if(!row)continue;
  row.aliases=[...new Set([...(row.aliases||[]),alias])];row.usageContext=use;
  const proof={at:d.observed_at,status:value.exit===0?'verified':'failed',layer:['registered_stable_material_query','pdf_yaml_actual_use'].includes(field)?'python_actual_use':'python_isolated_boot',exitCode:value.exit,stdout:value.stdout||'',stderr:value.stderr||'',evidence:s.diagnosis,sourceField:field,reason:value.exit===0?null:'当前基环境Lib/python312.zip缺失，初始化无法导入encodings；没有删除前完整性原证，不能归责清理。'};
  const previous=state.items?.[row.id];const newerBoot=previous&&['python_isolated_boot','python_actual_use'].includes(previous.layer)&&Date.parse(previous.at)>Date.parse(proof.at);
  if(!newerBoot&&!(previous?.evidence===proof.evidence&&previous?.sourceField===field&&previous?.at===proof.at))recordProof(state,row.id,proof);
 }
 const software=[];
 for(const item of software){const known=removed.prefixes?.[item.path];rows.push({...item,kind:'software',retired:true,availability:'retired',defaultCallable:false,pathExists:fs.existsSync(item.path),programFileCount:known?.files??null,observedAt:removed.at,verification:'removed_program_verified_from_original',sources:[s.software,s.overall,...(item.id==='software:stm32cubeide'?[s.stm32]:[])],preservedContentsRead:false,scope:item.id==='software:voicechanger'?`程序退出；${removed.voice_protected_files}份模型/媒体/配置原位保留，原程序调用不可继续使用。`:'程序已移除，个人原件保留位置/映射沿原证；未读取许可/配置正文。'});}
 for(const row of rows){
  if(['runtime','script','environment'].includes(row.kind)){const retired=software.find(p=>norm(row.path)===norm(p.path)||norm(row.path).startsWith(norm(p.path)+'/'));if(retired){row.retired=true;row.retiredBy=retired.id;row.defaultCallable=false;row.availability='retired';row.verification='retired_program';}}
  const proof=row.kind==='environment'?state.items?.[id('runtime',row.python)]:state.items?.[row.id];applyAvailability(row,proof);
  if(row.usageContext==='historical_mock_only')row.defaultCallable=false;
 }
 rows.push({id:'cache:uv',kind:'cache',name:'uv D盘缓存与共享硬链接（保留）',availability:'retained_cache',defaultCallable:false,cacheExistsObserved:true,approximateGigabytes:5.03,cliLookup:'当前PATH/有限安装位置CLI查询与缓存存在是不同事实，不能推断整机未安装。',verification:'retained_shared_hardlinks_from_cleanup_original',sources:[s.disk,s.overall],scope:'缓存与现用环境共享硬链接；本项不遍历缓存、不清理、不把路径体积当可回收物理空间。'});
 writeState(state);
 return {sources:Object.values(s),gaps:[],software:software.map(r=>r.id)};
}
