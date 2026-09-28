import { randomInt } from 'node:crypto';
import type { Question } from '../questions/schema.js';
import type { Policy } from './policy.js';
export function shuffle<T>(items:readonly T[]):T[]{const copy=[...items];for(let i=copy.length-1;i>0;i--){const j=randomInt(i+1);[copy[i],copy[j]]=[copy[j]!,copy[i]!];}return copy;}
export function selectQuestions<T extends {id:string;content:Question}>(pool:T[],policy:Policy,recent:Set<string>){
 const order=shuffle(pool).sort((a,b)=>Number(recent.has(a.id))-Number(recent.has(b.id)));
 const selected:T[]=[];const distribution=Object.entries(policy.distribution);const weight=distribution.reduce((sum,[,v])=>sum+v,0);
 for(const [difficulty,amount] of distribution){const target=Math.floor(policy.questionCount*amount/weight);selected.push(...order.filter(q=>q.content.difficulty===difficulty).slice(0,target));}
 const ids=new Set(selected.map(q=>q.id));selected.push(...order.filter(q=>!ids.has(q.id)).slice(0,policy.questionCount-selected.length));return shuffle(selected);
}
