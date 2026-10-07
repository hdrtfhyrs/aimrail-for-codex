import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../../public-paths.mjs";
import fs from 'node:fs';
const {recent,main} = await import(_publicURL("$system/本地统一/对话记录/action-manager/action-manager.mjs"));
const active=process.argv[2];
if(/^[a-f0-9-]{36}$/i.test(active||'')){
  try{await main(['route','--id',active]);}catch{}
}
const records=_publicPath("$system/本地统一/对话记录/");
const layout=JSON.parse(fs.readFileSync(records+'organization.json','utf8'));
const normalize=p=>p?.replaceAll('\\','/').replace(/\/$/,'')??null;
const result=recent({limit:500});
// Bound only the presentation. AI search/recent retains the full catalog.
const visible=[];
const counts=new Map();
for(const item of result.items){
  const key=item.groupKey??'unassigned';
  if(!counts.has(key))counts.set(key,[]);
  counts.get(key).push(item);
}
for(const items of counts.values()){
  const selected=items.slice(0,5);
  const current=items.find(i=>i.threadId===active);
  if(current&&!selected.includes(current))selected.splice(4,1,current);
  visible.push(...selected);
}
process.stdout.write(JSON.stringify({at:new Date().toISOString(),
  groups:layout.groups.map(g=>({key:g.key,name:g.name,projectPath:normalize(g.projectPath||_publicPath("$projects/")+g.project),total:counts.get(g.key)?.length??0})),
  items:visible.map(i=>({...i,project:normalize(i.project),updatedAt:i.updatedAt*1000})),
  source:'original threads.updated_at + existing semantic decisions',total:result.total,presentationLimitPerBoard:5}));
