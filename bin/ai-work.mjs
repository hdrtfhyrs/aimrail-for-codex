#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const home=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv=process.argv.slice(2);
for(let i=0;i<argv.length;i++) {
  if(argv[i]==='--workspace') {
    if(!argv[i+1] || argv[i+1].startsWith('--')) throw Error('--workspace needs a directory.');
    process.env.AI_WORK_HOME=path.resolve(argv[i+1]); argv.splice(i,2);i--;
  }
}
const {WORKSPACE,PROJECTS_ROOT,MEMORY_ROOT}=await import('../src/paths.mjs');
const {argumentsOf}=await import('../src/registry-store.mjs');
const print=value=>console.log(typeof value==='string'?value:JSON.stringify(value,null,2));
function writeNew(file,text) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if(fs.existsSync(file)) return false;
  fs.writeFileSync(file,text,{flag:'wx'});return true;
}
function initialize() {
  for(const dir of [PROJECTS_ROOT,...['knowledge','experiences','errors'].map(kind=>path.join(MEMORY_ROOT,kind)),path.join(WORKSPACE,'handoffs')]) fs.mkdirSync(dir,{recursive:true});
  const json=(name,value)=>writeNew(path.join(WORKSPACE,name),JSON.stringify(value,null,2)+'\n');
  json('projects.json',{schemaVersion:1,roots:['projects'],projects:[]});
  json('knowledge-sources.json',{schemaVersion:1,sources:['knowledge','experiences','errors'].map(kind=>({directory:'memory/'+kind,type:kind==='experiences'?'experience':kind==='errors'?'error':'knowledge',recursive:true,exclude:['INDEX.md']}))});
  json('knowledge-retirements.json',{schema:1,entries:[]});
  json('objects.json',{schemaVersion:1,revision:0,records:[]});
  json('resources.json',{schemaVersion:1,revision:0,accounts:[],benefits:[],resources:[],sources:[]});
  writeNew(path.join(WORKSPACE,'AGENTS.md'),fs.readFileSync(path.join(home,'templates','AGENTS.md'),'utf8'));
  return {workspace:WORKSPACE,existingFilesPreserved:true};
}
function initializeProject(options) {
  if(!options.name || !options.goal) throw Error('project init needs --name NAME --goal GOAL.');
  if(/[\\/<>:"|?*\x00-\x1f]/.test(options.name)||/[. ]$/.test(options.name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(options.name)) throw Error('Invalid project name.');
  const project=path.join(PROJECTS_ROOT,options.name);
  if(fs.existsSync(project)) throw Error('Project directory already exists; read its originals before changing it.');
  initialize();
  fs.mkdirSync(project,{recursive:true});
  for(const dir of ['主线','成果']) fs.mkdirSync(path.join(project,dir));
  const values={'{{PROJECT_NAME}}':options.name,'{{GOAL}}':options.goal};
  for(const name of ['核心.md','共享状态.md','项目概况.md','进展.md']) {
    let text=fs.readFileSync(path.join(home,'templates','project',name),'utf8');
    for(const [key,value] of Object.entries(values)) text=text.replaceAll(key,value);
    writeNew(path.join(project,name),text);
  }
  writeNew(path.join(project,'成果','INDEX.md'),'# 成果目录\n\n此处登记实际成果、原件、限制和接续。\n');
  return {project,goal:options.goal};
}
function moduleRun(name,args) {
  const child=spawnSync(process.execPath,[path.join(home,'src',name),...args],{stdio:'inherit',env:process.env,windowsHide:true});
  if(child.error) throw child.error;
  process.exitCode=child.status??1;
}
const help=`AI Work System — file-backed project and knowledge core

node bin/ai-work.mjs init --workspace PATH
node bin/ai-work.mjs project init --name NAME --goal GOAL --workspace PATH
node bin/ai-work.mjs projects --workspace PATH
node bin/ai-work.mjs context read --project ABS_DIR --branch ID --workspace PATH
node bin/ai-work.mjs context bind --host codex --session FULL_ID --project ABS_DIR --branch ID --workspace PATH
node bin/ai-work.mjs state update --project ABS_DIR --input JSON --workspace PATH
node bin/ai-work.mjs knowledge overview --workspace PATH
node bin/ai-work.mjs knowledge search --query TEXT --json --workspace PATH
node bin/ai-work.mjs recall search --query TEXT --no-vector --json --workspace PATH
node bin/ai-work.mjs objects list --workspace PATH
node bin/ai-work.mjs resources list --kind resources --workspace PATH
node bin/ai-work.mjs deliverables --help --workspace PATH
node bin/ai-work.mjs handoff --project ABS_DIR --branch ID --out FILE --workspace PATH

AI_WORK_HOME can also set the workspace. No services or login/startup triggers are installed.`;
try {
  const [command='help',...rest]=argv;
  if(command==='help'||command==='--help') print(help);
  else if(command==='init') { if(rest.length) throw Error('init accepts only --workspace.');print(initialize()); }
  else if(command==='project') { if(rest[0]!=='init') throw Error('Use project init.');print(initializeProject(argumentsOf(rest.slice(1)))); }
  else if(command==='projects') { if(rest.length) throw Error('projects accepts only --workspace.');const {projectDirectory}=await import('../src/project-registry.mjs');print(projectDirectory()); }
  else if(command==='handoff') {
    const options=argumentsOf(rest);
    if(!options.project||!options.branch||!options.out) throw Error('handoff needs --project, --branch and --out.');
    const {readContext}=await import('../src/project-context.mjs');
    const context=readContext({project:path.resolve(options.project),branchId:options.branch},{compact:false,host:'shared'});
    const output=path.resolve(options.out);fs.mkdirSync(path.dirname(output),{recursive:true});
    fs.writeFileSync(output,context.context+'\n',{flag:'wx'});
    print({output,project:context.project,branch:options.branch});
  } else {
    const modules={context:'project-context.mjs',state:'shared-state.mjs',knowledge:'knowledge.mjs',recall:'recall.mjs',objects:'object-access.mjs',resources:'resources.mjs',deliverables:'deliverables.mjs','record-experience':'knowledge-record.mjs'};
    if(!modules[command]) throw Error('Unknown command: '+command);
    moduleRun(modules[command],rest);
  }
} catch(error) { console.error(error.message);process.exitCode=1; }
