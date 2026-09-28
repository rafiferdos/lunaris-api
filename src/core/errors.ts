export class DomainError extends Error {
 constructor(public status:number,public code:string,message:string,public errors?:unknown){super(message);}
}
export function assert(condition:unknown,status:number,code:string,message:string):asserts condition {if(!condition)throw new DomainError(status,code,message);}
