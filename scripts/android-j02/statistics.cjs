'use strict';
// Exact one-sided Clopper-Pearson via a log-sum binomial CDF and bisection.
// No normal approximation, synthetic successes, or effective-n estimate.
function cdf(k,n,p){
    if(k<0)return 0;if(k>=n||p===0)return 1;if(p===1)return 0;
    let term=n*Math.log1p(-p),max=term,sum=1;
    for(let i=1;i<=k;i++){
        term+=Math.log(n-i+1)-Math.log(i)+Math.log(p)-Math.log1p(-p);
        if(term>max){sum=sum*Math.exp(max-term)+1;max=term;}else sum+=Math.exp(term-max);
    }
    return Math.min(1,Math.exp(max+Math.log(sum)));
}
function upper(k,n,alpha=0.05){
    if(!Number.isInteger(n)||!Number.isInteger(k)||n<0||k<0||k>n||!(alpha>0&&alpha<1))throw Error('invalid binomial sample');
    if(n===0)return null;if(k===n)return 1;if(k===0)return -Math.expm1(Math.log(alpha)/n);
    let lo=0,hi=1;for(let i=0;i<70;i++){const mid=(lo+hi)/2;if(cdf(k,n,mid)>alpha)lo=mid;else hi=mid;}return (lo+hi)/2;
}
const lower=(k,n,a=0.05)=>n?1-upper(n-k,n,a):null;
const rate=(k,n,a=0.05)=>({numerator:k,denominator:n,estimate:n?k/n:null,lower:lower(k,n,a),upper:upper(k,n,a)});
function percentile(values,p){const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return sorted.length?sorted[Math.ceil(sorted.length*p)-1]:null;}
module.exports={cdf,upper,lower,rate,percentile};
