import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../../public-paths.mjs";
import {read} from '../conversations.mjs';
export async function historyUserEvents(id){
 const events=[],conversationContext=[];let offset=0,source=null;
 while(true){
  const page=await read(id,{offset,limit:50,chars:20000});
  if(!page.contentAvailable)throw Error('Original log and visible history are unavailable');
  source=page.contentSource;
  for(const message of page.items){
   if(!['user','assistant'].includes(message.role)||['context-envelope','automation-instruction'].includes(message.contentKind))continue;
   let text=message.text;
   while(text.length<message.characters){
    const rest=await read(id,{offset:message.index,limit:1,chars:20000,'char-offset':text.length});
    const part=rest.items[0]?.text;if(!part)throw Error('Incomplete visible history message');text+=part;
   }
   conversationContext.push({at:message.timestamp,role:message.role,text,contentKind:message.contentKind});
   if(message.role==='user')events.push({at:message.timestamp,text,images:[],imageContentUnavailable:true,contentKind:message.contentKind});
  }
  if(page.nextOffset===null)break;offset=page.nextOffset;
 }
 return {events,conversationContext,source,boundary:'Visible history projection includes adjacent assistant context; missing original tool questions/images are not reconstructed. If an answer/question relation is incomplete, preserve binding rather than infer a new goal.'};
}
