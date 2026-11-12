'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {upper,lower,percentile,cdf}=require('../scripts/android-j02/statistics.cjs');
const {check}=require('../scripts/android-j02/checker.cjs');
test('exact one-sided limits retain the 30, 149 and multiplicity thresholds',()=>{
    assert.ok(Math.abs(upper(0,30)-0.0950338528553)<1e-12);assert.ok(upper(0,148)>=0.02);assert.ok(upper(0,149)<0.02);
    assert.ok(upper(0,202,0.05/3)>=0.02);assert.ok(upper(0,203,0.05/3)<0.02);
    assert.equal(upper(0,0),null);assert.equal(lower(0,0),null);assert.equal(lower(0,20),0);assert.equal(upper(20,20),1);
    assert.ok(Math.abs(lower(20,20)-Math.pow(0.05,1/20))<1e-12);
});
test('nonzero-event bounds agree with independent small-binomial polynomial evaluation',()=>{
    const direct=(k,n,p)=>{let sum=0;for(let i=0;i<=k;i++){let comb=1;for(let j=1;j<=i;j++)comb*=((n-j+1)/j);sum+=comb*p**i*(1-p)**(n-i);}return sum;};
    for(const [k,n] of [[1,10],[3,20],[7,15]]){assert.ok(Math.abs(direct(k,n,upper(k,n))-0.05)<1e-12);assert.ok(Math.abs(cdf(k,n,0.3)-direct(k,n,0.3))<1e-12);}
    assert.ok(Number.isFinite(upper(20,10000)));assert.equal(percentile([40,10,20,30],0.5),20);assert.equal(percentile([],0.95),null);
});
const node=(id,text='',inside='',extra='')=>`<node package="com.example" resource-id="com.example:id/${id}" text="${text}" enabled="true" visible-to-user="true" bounds="[0,0][90,90]" ${extra}>${inside}</node>`;
const xml=body=>'<?xml version="1.0"?><hierarchy>'+body+'</hierarchy>';
const spec={version:'raw-ui-v1',package:'com.example',all:[{type:'row',target:{id:'com.example:id/list'},fields:[
    {target:{id:'com.example:id/title'},equals:'Book'},{target:{id:'com.example:id/author'},equals:'Author'}]}]};
test('independent checker rejects cross-row, hidden ancestor, duplicate and aliased fields',()=>{
    const row=(a,b)=>node('row','',node('title',a)+node('author',b));const viewport={width:100,height:200};
    assert.equal(check(xml(node('list','',row('Book','Author'))),spec,viewport).verdict,'pass');
    assert.equal(check(xml(node('list','',row('Book','Other')+row('Other','Author'))),spec,viewport).verdict,'fail');
    assert.equal(check(xml(node('list','',row('Book','Author'))).replace('resource-id="com.example:id/row" text="" enabled="true" visible-to-user="true"','resource-id="com.example:id/row" text="" enabled="true" visible-to-user="false"'),spec,viewport).verdict,'fail');
    assert.equal(check(xml(node('list','',row('Book','Author'))+node('list')),spec,viewport).verdict,'fail');
    const alias=structuredClone(spec);alias.all[0].fields[1]={target:{text:'Book'},equals:'Book'};
    assert.equal(check(xml(node('list','',row('Book','Author'))),alias,viewport).verdict,'fail');
    assert.equal(check(xml(node('list')).replaceAll('com.example','other.app'),spec,viewport).verdict,'unknown');
    assert.throws(()=>check(xml('<!DOCTYPE hierarchy>'),spec,viewport),{code:'J02_CHECKER_XML'});
});
