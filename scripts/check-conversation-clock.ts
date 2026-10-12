// Real model integration check with explicitly simulated clock instants.
import {createOriginConversationProvider} from '../src/providers/origin-conversation.ts';
const cases = [
 {zone:'Asia/Tokyo',now:'2026-12-31T15:30:00Z',input:'今日はいつですか？',expected:'2027年1月1日'},
 {zone:'America/Los_Angeles',now:'2026-12-31T15:30:00Z',input:'今日はいつですか？',expected:'2026年12月31日'},
 {zone:'Asia/Tokyo',now:'2026-12-31T15:30:00Z',input:'今日は何曜日ですか？',expected:'金曜日'},
 {zone:'Asia/Tokyo',now:'2026-12-31T15:30:00Z',input:'明日は何月何日ですか？',expected:'1月2日'},
 {zone:'UTC',now:'2028-03-01T00:30:00Z',input:'昨日は何月何日ですか？',expected:'2月29日'}
];
const results=[];
for (const c of cases) {
 const provider=createOriginConversationProvider({timeZone:c.zone,now:()=>new Date(c.now)});
 const answer=await provider.complete([{role:'user',content:c.input}],[],{root:'',outline:'',mode:'chat'});
 const result={...c,answer,passed:answer.normalize('NFKC').includes(c.expected)};
 results.push(result);console.log(JSON.stringify(result));
}
console.log(JSON.stringify({passed:results.filter(x=>x.passed).length,total:results.length}));
process.exitCode=results.every(x=>x.passed)?0:1;
