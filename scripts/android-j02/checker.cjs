'use strict';
// Independent DOM reader: does not import the task's selector or completion engine.
const {DOMParser}=require('@xmldom/xmldom');
const {fail}=require('./contract.cjs');
function check(xml,spec,viewport){
    if(typeof xml!=='string'||Buffer.byteLength(xml)>8*1024*1024||/<!DOCTYPE|<!ENTITY/i.test(xml))throw fail('J02_CHECKER_XML');
    const start=xml.indexOf('<?xml'),end=xml.lastIndexOf('</hierarchy>');if(start<0||end<start)throw fail('J02_CHECKER_XML');
    const invalid=()=>{throw fail('J02_CHECKER_XML');};
    const doc=new DOMParser({errorHandler:{warning:invalid,error:invalid,fatalError:invalid}}).parseFromString(xml.slice(start,end+12),'text/xml');
    if(doc.documentElement.tagName!=='hierarchy')throw fail('J02_CHECKER_XML');
    const all=Array.from(doc.getElementsByTagName('node'));
    if(!all.some(n=>n.getAttribute('package')===spec.package))return{verdict:'unknown',checks:[]};
    const safe=n=>{
        if(!n||n.getAttribute('package')!==spec.package)return false;
        for(let a=n;a?.tagName==='node';a=a.parentNode){
            if(a.getAttribute('visible-to-user')!=='true'||a.getAttribute('password')==='true'||a.getAttribute('enabled')==='false')return false;
        }
        const b=/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(n.getAttribute('bounds'))?.slice(1).map(Number);
        return !!b&&b[0]>=0&&b[1]>=0&&b[2]>b[0]&&b[3]>b[1]&&b[2]<=viewport.width&&b[3]<=viewport.height;
    };
    const find=(target,nodes=all)=>nodes.filter(n=>n.getAttribute('package')===spec.package&&Object.entries(target).every(([k,v])=>
        n.getAttribute(({id:'resource-id',desc:'content-desc'})[k]||k)===v));
    const normalized=(v,c)=>{let s=v;if(c.normalize)s=s.normalize('NFC').trim();if(c.stripPrefix&&s.startsWith(c.stripPrefix))s=s.slice(c.stripPrefix.length).trimStart();return s;};
    const text=(c,nodes)=>{const hits=find(c.target,nodes);return hits.length===1&&safe(hits[0])&&normalized(hits[0].getAttribute('text'),c)===normalized(c.equals,c)?hits[0]:null;};
    const checks=spec.all.map(c=>{
        if(c.type==='text')return !!text(c,all);
        const hits=find(c.target);if(c.type==='absent')return hits.length===0;
        if(hits.length!==1||!safe(hits[0]))return false;
        if(c.type==='visible')return true;
        if(c.type==='checked')return hits[0].getAttribute('checkable')==='true'&&hits[0].getAttribute('checked')===String(c.checked);
        const rows=Array.from(hits[0].childNodes).filter(n=>n.nodeType===1);
        return rows.some(row=>{const nodes=[row,...Array.from(row.getElementsByTagName('node'))],fields=c.fields.map(f=>text(f,nodes));
            return fields.every(Boolean)&&new Set(fields).size===fields.length;});
    });
    return {verdict:checks.every(Boolean)?'pass':'fail',checks};
}
module.exports={check};
