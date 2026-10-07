import {integrationPath} from '../paths.mjs';
// Unranked local declarations. AI chooses which evidence applies; this module
// only lists/reads registered files. No keyword recall, model call or adoption.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {objectNavigation,objectCli,OBJECT_ENTRY} from './object-access.mjs';
const base=integrationPath('workspace');
const read=file=>fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');
export function localDeclarations({project}={}){
 const items=[
  {id:'local-index',kind:'navigation',title:'本地知识总导航',path:base+'/memory/INDEX.md'},
  {id:'experience-index',kind:'navigation',title:'成功经验与待验证案例目录',path:base+'/memory/experiences/INDEX.md'},
  {id:'error-index',kind:'navigation',title:'失败与纠错目录',path:base+'/memory/errors/INDEX.md'},
  {id:'knowledge-index',kind:'navigation',title:'领域知识文档目录',path:base+'/memory/knowledge/INDEX.md'},
  {id:'user-rules',kind:'configuration',title:'本人活动规则声明',path:integrationPath('integrations/AGENTS.md')},
  {id:'hook-registration',kind:'configuration',title:'本机hook注册',path:integrationPath('integrations/hooks.json')},
  {id:'project-state-rules',kind:'configuration',title:'项目/共享分支关联方法',path:integrationPath('integrations/prompts/project-state.md')},
  {id:'global-outcomes',kind:'artifact',title:'全局成果目录',path:base+'/projects/成果总览.md'}];
 items.push({id:'resource-usage',kind:'navigation',title:'本地资产及账号资源同源登记用法',path:integrationPath('modules/system/资料中心/使用说明.md')});
 items.push({id:'object-knowledge-usage',kind:'navigation',title:'对象/类别知识与生产维护接口',path:integrationPath('modules/system/资料中心/object-knowledge/接口约定.md')});
 items.push({id:'object-knowledge-entry',kind:'capability',title:'理解任务时取得对象、属性、状态与关系',path:OBJECT_ENTRY});
 for(const [kind,root] of [['experience',base+'/memory/experiences'],['error',base+'/memory/errors'],['knowledge',base+'/memory/knowledge'],['role',integrationPath('integrations/agents/codex')]]){
  try{for(const f of fs.readdirSync(root,{withFileTypes:true})){
   if(!f.isFile()||!(/\.(md|toml)$/i.test(f.name))||['INDEX.md','WRITING.md','REVIEWER.md'].includes(f.name))continue;
   const file=path.join(root,f.name),body=read(file),title=body.match(/^#\s+([^\n]+)/m)?.[1]||f.name;
   items.push({id:kind+':'+f.name,kind,title,path:file});
  }}catch{}
 }
 if(project){for(const [id,title,rel] of [['project-core','项目完整核心','核心.md'],['project-state','当前全部共享分支','共享状态.md'],['project-outcomes','本项目成果目录','成果/INDEX.md'],['project-capabilities','中央能力路径声明','运行中心/modules.json']])items.push({id,kind:'project',title,path:path.join(project,rel)});}
 return {items:items.map(x=>({...x,exists:fs.existsSync(x.path)})),selection:'unranked',boundary:'完整登记导航；经验在目录中不表示已成功，适用性/采用由AI结合目标与原证判断。'};
}
export function localNavigation({project,includeCounts=true,includeObjects=true}={}){
 const d=includeCounts?localDeclarations({project}):null;
 const count=k=>d.items.filter(x=>x.kind===k).length;
 return [`本地导航：node "${integrationPath('integrations')}/context/local-navigation.mjs" list${project?' --project "'+project+'"':''}；read --id experience-index或--id "experience:文件.md"读取原件。`,
  `登记目录：${includeCounts?`经验${count('experience')}、错误${count('error')}、知识${count('knowledge')}、角色${count('role')}`:'经验、错误、知识和角色'}；完整目录沿list或${base}/memory/INDEX.md读取。`,
  `配置：${integrationPath('integrations')}/AGENTS.md、hooks.json、prompts/project-state.md；成果：${base}/projects/成果总览.md${project?'；'+path.join(project,'成果/INDEX.md'):''}。`,
  includeObjects?objectNavigation():null].filter(Boolean).join('\n');
}
export function readLocalDeclaration({id,project,offset=0,chars=12000}={}){
 const source=localDeclarations({project}).items.find(x=>x.id===id);if(!source||!source.exists)throw Error('Unknown/unavailable local declaration ID');
 if(!Number.isInteger(offset)||offset<0||!Number.isInteger(chars)||chars<1||chars>50000)throw Error('offset/ chars invalid');
 const body=read(source.path),end=Math.min(body.length,offset+chars);if(offset>body.length)throw Error('offset out of range');
 return {source,content:body.slice(offset,end),offset,end,total_chars:body.length,complete:end===body.length,next:end<body.length?{id,project,offset:end,chars}:null};
}
export function localCli(argv=process.argv.slice(2)){
 if(argv[0]==='objects')return objectCli(argv.slice(1));
 const [command='navigation',...args]=argv,options={};for(let i=0;i<args.length;i+=2){if(!args[i].startsWith('--')||args[i+1]===undefined)throw Error('Use --option value');options[args[i].slice(2)]=args[i+1];}
 if(command==='navigation')return localNavigation(options);
 if(command==='list'){const result=localDeclarations(options);return options.kind?{...result,items:result.items.filter(x=>x.kind===options.kind)}:result;}
 if(command==='read')return readLocalDeclaration({...options,offset:Number(options.offset||0),chars:Number(options.chars||12000)});
 return 'navigation | list [--project ABS_DIR] [--kind experience|error|knowledge|role|configuration|project|capability] | read --id ID [--project ABS_DIR --offset 0 --chars 12000] | objects list|resolve|read|expand|search|audit|help <原参数>. AI decides applicability; program only lists/reads.';
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{const result=localCli();console.log(typeof result==='string'?result:JSON.stringify(result,null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
