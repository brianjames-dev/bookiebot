type Occurrence={available:boolean;month:string;recorded?:boolean;virtual?:boolean;amountCents?:number;date?:string|null}

/** Recorded zero cash is still a charge. A due virtual subscription is also
 * already represented in Current, but a future estimate/actual is not a hit. */
export function currentBillHasHit(charge:Occurrence,month:string,today:string,amountCents:number|null){
 return charge.available&&charge.month===month&&Boolean(charge.recorded||charge.date&&charge.date<=today&&((charge.amountCents??0)>0||charge.virtual&&(amountCents??0)>0))
}

export function recurringStartMonth(month:string,earliest?:string){return earliest&&earliest>month?earliest:month}
