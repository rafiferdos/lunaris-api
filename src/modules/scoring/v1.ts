import type { Mode, Question } from '../questions/schema.js';
export const scoring={EASY:{CORRECT:1,PARTIAL:0.5,WRONG:0,BEST:1,STRONG:1,ACCEPTABLE:0.5,WEAK:0},MEDIUM:{CORRECT:2,PARTIAL:1,WRONG:-1,BEST:5,STRONG:2,ACCEPTABLE:1,WEAK:-1},COMPETITIVE:{CORRECT:3,PARTIAL:1,WRONG:-2,BEST:7,STRONG:3,ACCEPTABLE:1,WEAK:-2}} as const;
export const clamp=(value:number,min=0,max=100)=>Math.max(min,Math.min(max,value));
export function multipleQuality(correct:string[],selected:string[]){const unique=[...new Set(selected)];const tp=unique.filter(id=>correct.includes(id)).length;return correct.length?Math.max(0,(tp-(unique.length-tp))/correct.length):0;}
export function evaluate(q:Question,selected:string[],mode:Mode){
 const config=scoring[mode];const skipped=selected.length===0;
 const maximum=q.type==='WEIGHTED_CHOICE'?config.BEST:config.CORRECT;
 if(q.type==='WEIGHTED_CHOICE'){
 const outcome=skipped?'SKIPPED':q.options.find(o=>o.id===selected[0])?.quality??'WEAK';
 const quality={BEST:1,STRONG:0.75,ACCEPTABLE:0.4,WEAK:0,SKIPPED:0}[outcome];
 return {outcome,points:outcome==='SKIPPED'?config.WEAK:config[outcome],minimum:config.WEAK,maximum,quality,objective:false};
 }
 const correct=q.options.filter(o=>o.isCorrect).map(o=>o.id);
 const quality=q.type==='MULTIPLE_CHOICE'?multipleQuality(correct,selected):Number(selected.length===1&&correct.includes(selected[0]!));
 const outcome=skipped?'SKIPPED':quality===1?'CORRECT':quality>0?'PARTIAL':'WRONG';
 return {outcome,points:outcome==='SKIPPED'?config.WRONG:config[outcome],minimum:config.WRONG,maximum,quality,objective:true};
}
export function score(questions:Question[],answers:string[][],mode:Mode){
 const reviews=questions.map((q,i)=>evaluate(q,answers[i]??[],mode));
 const rawScore=reviews.reduce((s,r)=>s+r.points,0),minimumPossibleScore=reviews.reduce((s,r)=>s+r.minimum,0),maximumPossibleScore=reviews.reduce((s,r)=>s+r.maximum,0);
 const range=maximumPossibleScore-minimumPossibleScore;
 const objective=reviews.filter(r=>r.objective),weighted=reviews.filter(r=>!r.objective);
 return {engineVersion:'scoring/v1',rawScore,minimumPossibleScore,maximumPossibleScore,normalizedScore:range?clamp((rawScore-minimumPossibleScore)/range*100):0,accuracyPercent:objective.length?objective.filter(r=>r.outcome==='CORRECT').length/objective.length*100:null,answerQualityPercent:weighted.length?weighted.reduce((s,r)=>s+r.quality,0)/weighted.length*100:null,correct:reviews.filter(r=>r.outcome==='CORRECT').length,partial:reviews.filter(r=>r.outcome==='PARTIAL').length,skipped:reviews.filter(r=>r.outcome==='SKIPPED').length,reviews};
}
