// src/drivers/VAccelerometer.js

import { logger } from '../system/Logger.js';
import { DEVICE_MODEL } from './HardwareBus.js';

export const AccelState = { OFF:'off', READY:'ready', SAMPLING:'sampling', ERROR:'error' };
export const AccelRange = { G_2:2, G_4:4, G_8:8, G_16:16 };
export const Orientation = { PORTRAIT:'portrait', LANDSCAPE_LEFT:'landscape-left', LANDSCAPE_RIGHT:'landscape-right', PORTRAIT_UPSIDE:'portrait-upside-down', FACE_UP:'face-up', FACE_DOWN:'face-down', UNKNOWN:'unknown' };
export const Activity = { STATIONARY:'stationary', WALKING:'walking', RUNNING:'running', CYCLING:'cycling', AUTOMOTIVE:'automotive', UNKNOWN:'unknown' };

const THRESHOLDS = { SHAKE_G:2.2, SHAKE_DURATION_MS:250, FREEFALL_G:0.3, FREEFALL_MIN_MS:120, IMPACT_G:5.0, TILT_MIN_DEG:15, STILL_MAX_G:0.02 };
const STEP_CADENCE = { [Activity.STATIONARY]:0, [Activity.WALKING]:100, [Activity.RUNNING]:160, [Activity.CYCLING]:0, [Activity.AUTOMOTIVE]:0, [Activity.UNKNOWN]:0 };
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const powerMicroAmp=hz=>10+(hz/800)*490;

class LowPassFilter {
  constructor(alpha=0.2){this.alpha=alpha;this.state={x:0,y:0,z:0};this.initialized=false;}
  apply(sample){if(!this.initialized){this.state={...sample};this.initialized=true;return {...sample};} for(const k of ['x','y','z']) this.state[k]+=this.alpha*(sample[k]-this.state[k]); return {...this.state};}
  setAlpha(a){this.alpha=clamp(a,0.01,1);}
  reset(){this.initialized=false;this.state={x:0,y:0,z:0};}
}

class SampleBuffer {
  constructor(capacity){this.capacity=capacity;this.buffer=new Array(capacity);this.head=0;this.size=0;}
  push(sample){this.buffer[this.head]=sample;this.head=(this.head+1)%this.capacity;if(this.size<this.capacity)this.size++;}
  toArray(){if(!this.size)return [];if(this.size<this.capacity)return this.buffer.slice(0,this.size);const out=[];for(let i=0;i<this.capacity;i++)out.push(this.buffer[(this.head+i)%this.capacity]);return out;}
  last(n){if(n>=this.size)return this.toArray();const out=[];for(let i=0;i<n;i++)out.push(this.buffer[(this.head-n+i+this.capacity)%this.capacity]);return out;}
  clear(){this.buffer=new Array(this.capacity);this.head=0;this.size=0;}
  get length(){return this.size;}
}

export class VAccelerometer {
  constructor(bus){
    this.bus=bus;this.name='VAccelerometer';this.model=DEVICE_MODEL.sensors.accelerometer.name;
    this.initialized=false;this.running=false;this.state=AccelState.OFF;
    this.rangeG=AccelRange.G_16;this.sampleRateHz=100;this.enabled=true;this.lowPowerMode=false;
    this.current={x:0,y:0,z:-1};this.gravity={x:0,y:0,z:-1};this.linear={x:0,y:0,z:0};this.filter=new LowPassFilter(0.15);
    this.bias={x:0,y:0,z:0};this.scale={x:1,y:1,z:1};this.calibration={calibrated:false,calibratedAt:null,noiseG:0.008,biasG:{x:0,y:0,z:0}};
    this.orientation=Orientation.FACE_UP;this.activity=Activity.STATIONARY;this.activitySince=Date.now();
    this.steps={total:0,today:0,lastResetTs:Date.now(),cadenceSpm:0,lastStepTs:0,walkingDistanceM:0};
    this.detection={shake:false,shakeIntensity:0,lastShakeTs:null,freeFall:false,freeFallStart:null,impact:false,lastImpactTs:null,peakG:0};
    this.historySize=600;this.history=new SampleBuffer(this.historySize);
    this.throughput={samplesLastSec:0,samplesTotal:0,lastSecondTs:Date.now(),actualHz:0};
    this.subscribers=new Set();this.orientationSubscribers=new Set();this.activitySubscribers=new Set();this.stepSubscribers=new Set();this.motionSubscribers=new Set();
    this.tickId=null;this.tickIntervalMs=Math.max(1,Math.round(1000/this.sampleRateHz));
    this._lastOrientationCheck=0;this._lastActivityCheck=0;this._freeFallStart=null;this._shakeStart=null;
    this.metrics={samplesTaken:0,shakeEvents:0,freeFallEvents:0,impactEvents:0,orientationChanges:0,activityChanges:0,stepsDetected:0,calibrationCount:0,errors:0,startedAt:null};
    this.currentPowerMw=0;
    logger.kernel('VAccelerometer',`creado: ${this.model} (${this.rangeG}g, ${this.sampleRateHz}Hz)`);
  }

  async init(){if(this.initialized)return;this.initialized=true;this.metrics.startedAt=Date.now();this.state=AccelState.READY;this._startTickLoop();this.calibrate({silent:true});logger.info('VAccelerometer',`✓ init: ${this.model}, ±${this.rangeG}g, ${this.sampleRateHz}Hz`);this.bus?.raiseInterrupt?.('IRQ_SENSOR',{source:'vaccel',event:'ready'},'vaccel');}
  _startTickLoop(){if(this.running)return;this.running=true;this.state=AccelState.SAMPLING;this.tickId=setInterval(()=>this._tick(),this.tickIntervalMs);}
  async shutdown(){if(!this.running)return;this.running=false;clearInterval(this.tickId);this.tickId=null;this.state=AccelState.OFF;this.currentPowerMw=0;logger.info('VAccelerometer','apagado');}

  _tick(){if(!this.running)return;const now=Date.now();const dtSec=this.tickIntervalMs/1000;const sample=this._simulateSample(dtSec);const calibrated={x:(sample.x-this.bias.x)*this.scale.x,y:(sample.y-this.bias.y)*this.scale.y,z:(sample.z-this.bias.z)*this.scale.z};const filtered=this.filter.apply(calibrated);this.current=filtered;const a=0.05;this.gravity.x=this.gravity.x*(1-a)+filtered.x*a;this.gravity.y=this.gravity.y*(1-a)+filtered.y*a;this.gravity.z=this.gravity.z*(1-a)+filtered.z*a;this.linear.x=filtered.x-this.gravity.x;this.linear.y=filtered.y-this.gravity.y;this.linear.z=filtered.z-this.gravity.z;this._detectOrientation(now);this._detectActivity(now,dtSec);this._updateStepCounter(now,dtSec);this._detectMotionEvents(now,dtSec);this._pushHistory(now);this._updateThroughput(now);this.currentPowerMw=(powerMicroAmp(this.sampleRateHz)*3.7)/1000;this._emit();this.metrics.samplesTaken++;this.throughput.samplesTotal++;}

  _simulateSample(dtSec){const noise=this.calibration.noiseG,bias=this.calibration.biasG;let baseX=0,baseY=0,baseZ=-1;if(this.activity===Activity.WALKING||this.activity===Activity.RUNNING){const cadence=STEP_CADENCE[this.activity]/60,t=Date.now()/1000,amp=this.activity===Activity.RUNNING?0.9:0.35;baseY+=Math.sin(2*Math.PI*cadence*t)*amp;baseZ+=Math.cos(2*Math.PI*cadence*t)*amp*0.5;}else if(this.activity===Activity.AUTOMOTIVE){const t=Date.now()/1000;baseX+=Math.sin(2*Math.PI*25*t)*0.05;baseY+=Math.sin(2*Math.PI*27*t)*0.05;}if(this.detection.shake){const t=Date.now()/1000;baseX+=Math.sin(2*Math.PI*8*t)*this.detection.shakeIntensity;baseY+=Math.sin(2*Math.PI*11*t)*this.detection.shakeIntensity;baseZ+=Math.sin(2*Math.PI*13*t)*this.detection.shakeIntensity;}if(this.detection.freeFall){baseX*=0.05;baseY*=0.05;baseZ*=0.05;}const r=()=> (Math.random()-0.5)*2*noise;return{x:baseX+bias.x+r(),y:baseY+bias.y+r(),z:baseZ+bias.z+r()};}

  _detectOrientation(now){if(now-this._lastOrientationCheck<100)return;this._lastOrientationCheck=now;const g=this.gravity,mag=Math.hypot(g.x,g.y,g.z);if(mag<0.5)return;const nx=g.x/mag,ny=g.y/mag,nz=g.z/mag;let o=this.orientation;if(Math.abs(nz)>0.75)o=nz<0?Orientation.FACE_UP:Orientation.FACE_DOWN;else if(Math.abs(nx)>Math.abs(ny))o=nx<0?Orientation.PORTRAIT:Orientation.PORTRAIT_UPSIDE;else o=ny>0?Orientation.LANDSCAPE_LEFT:Orientation.LANDSCAPE_RIGHT;if(o!==this.orientation){const prev=this.orientation;this.orientation=o;this.metrics.orientationChanges++;for(const fn of this.orientationSubscribers){try{fn({orientation:o,prev});}catch(_) {}}this.bus?.raiseInterrupt?.('IRQ_SENSOR',{source:'vaccel',event:'orientation-changed',orientation:o,prev},'vaccel');}}
  _detectActivity(now,dtSec){if(now-this._lastActivityCheck<1000)return;this._lastActivityCheck=now;const linMag=Math.hypot(this.linear.x,this.linear.y,this.linear.z),cadence=this.steps.cadenceSpm;let a=this.activity;if(linMag<0.03&&cadence<5)a=Activity.STATIONARY;else if(cadence>=140)a=Activity.RUNNING;else if(cadence>=60)a=Activity.WALKING;else if(linMag>0.15&&this._isLowFrequencyMotion())a=Activity.AUTOMOTIVE;else if(linMag>0.05&&cadence<20)a=Activity.CYCLING;else a=Activity.UNKNOWN;if(a!==this.activity){const prev=this.activity;this.activity=a;this.activitySince=now;this.metrics.activityChanges++;for(const fn of this.activitySubscribers){try{fn({activity:a,prev,since:this.activitySince});}catch(_) {}}this.bus?.raiseInterrupt?.('IRQ_MOTION',{source:'vaccel',event:'activity-changed',activity:a,prev},'vaccel');}}
  _isLowFrequencyMotion(){const r=this.history.last(20);if(r.length<10)return false;const m=r.map(s=>Math.hypot(s.x,s.y,s.z)),avg=m.reduce((a,b)=>a+b,0)/m.length,v=m.reduce((a,x)=>a+(x-avg)**2,0)/m.length;return v<0.05;}
  _updateStepCounter(now,dtSec){const cadence=STEP_CADENCE[this.activity]||0;if(!cadence){this.steps.cadenceSpm*=0.9;return;}this.steps.cadenceSpm=this.steps.cadenceSpm*0.85+cadence*0.15;const add=this.steps.cadenceSpm/60*dtSec,prev=Math.floor(this.steps.today);this.steps.today+=add;this.steps.total+=add;this.steps.walkingDistanceM+=add*(this.activity===Activity.RUNNING?1.2:0.75);const whole=Math.floor(this.steps.today);if(whole>prev){for(let i=0;i<whole-prev;i++){this.metrics.stepsDetected++;this.steps.lastStepTs=now;for(const fn of this.stepSubscribers){try{fn({total:Math.floor(this.steps.total),today:whole});}catch(_) {}}}this.bus?.raiseInterrupt?.('IRQ_MOTION',{source:'vaccel',event:'step',total:Math.floor(this.steps.total),today:whole,cadence:Number(this.steps.cadenceSpm.toFixed(1))},'vaccel');}}

  _detectMotionEvents(now,dtSec){const mag=Math.hypot(this.current.x,this.current.y,this.current.z);if(mag>this.detection.peakG)this.detection.peakG=mag;if(mag>THRESHOLDS.SHAKE_G){if(!this._shakeStart)this._shakeStart=now;if(now-this._shakeStart<=THRESHOLDS.SHAKE_DURATION_MS&&!this.detection.shake){this.detection.shake=true;this.detection.shakeIntensity=Math.min(1,(mag-THRESHOLDS.SHAKE_G)/3);this.detection.lastShakeTs=now;this.metrics.shakeEvents++;for(const fn of this.motionSubscribers){try{fn({type:'shake',magnitude:mag,intensity:this.detection.shakeIntensity});}catch(_) {}}this.bus?.raiseInterrupt?.('IRQ_MOTION',{source:'vaccel',event:'shake',magnitude:Number(mag.toFixed(2))},'vaccel');}}else if(this.detection.shake&&mag<THRESHOLDS.SHAKE_G*0.7){this.detection.shake=false;this.detection.shakeIntensity=0;this._shakeStart=null;}if(mag<THRESHOLDS.FREEFALL_G){if(!this._freeFallStart)this._freeFallStart=now;else if(now-this._freeFallStart>THRESHOLDS.FREEFALL_MIN_MS&&!this.detection.freeFall){this.detection.freeFall=true;this.detection.freeFallStart=this._freeFallStart;this.metrics.freeFallEvents++;for(const fn of this.motionSubscribers){try{fn({type:'free-fall',since:this._freeFallStart});}catch(_) {}}this.bus?.raiseInterrupt?.('IRQ_MOTION',{source:'vaccel',event:'free-fall'},'vaccel');}}else{if(this.detection.freeFall){this.detection.freeFall=false;this.detection.freeFallStart=null;}this._freeFallStart=null;}if(mag>THRESHOLDS.IMPACT_G){const since=now-(this.detection.lastImpactTs||0);if(since>1000){this.detection.impact=true;this.detection.lastImpactTs=now;this.metrics.impactEvents++;for(const fn of this.motionSubscribers){try{fn({type:'impact',magnitude:mag});}catch(_) {}}this.bus?.raiseInterrupt?.('IRQ_MOTION',{source:'vaccel',event:'impact',magnitude:Number(mag.toFixed(2))},'vaccel');}}}
  _pushHistory(now){this.history.push({ts:now,x:this.current.x,y:this.current.y,z:this.current.z,linX:this.linear.x,linY:this.linear.y,linZ:this.linear.z});}
  _updateThroughput(now){if(now-this.throughput.lastSecondTs>=1000){this.throughput.actualHz=this.throughput.samplesLastSec;this.throughput.samplesLastSec=0;this.throughput.lastSecondTs=now;}this.throughput.samplesLastSec++;}

  setRange(rangeG){if(!Object.values(AccelRange).includes(rangeG))return false;this.rangeG=rangeG;this._emit();return true;}
  setSampleRate(hz){hz=clamp(Math.round(hz),1,800);if(hz===this.sampleRateHz)return true;this.sampleRateHz=hz;this.tickIntervalMs=Math.max(1,Math.round(1000/hz));if(this.running){clearInterval(this.tickId);this.tickId=setInterval(()=>this._tick(),this.tickIntervalMs);}this._emit();return true;}
  setEnabled(on){this.enabled=!!on;if(!this.enabled&&this.running)this.shutdown();else if(this.enabled&&!this.running)this._startTickLoop();this._emit();}
  setLowPowerMode(on){this.lowPowerMode=!!on;if(this.lowPowerMode)this.setSampleRate(Math.min(this.sampleRateHz,10));this._emit();}
  calibrate({silent=false}={}){const now=Date.now(),bias={x:(Math.random()-0.5)*0.01,y:(Math.random()-0.5)*0.01,z:(Math.random()-0.5)*0.01};this.bias={x:0,y:0,z:0};this.calibration={calibrated:true,calibratedAt:now,noiseG:this.calibration.noiseG,biasG:bias};this.metrics.calibrationCount++;if(!silent)this._emit();return this.calibration;}
  resetCalibration(){this.calibration.calibrated=false;this.calibration.calibratedAt=null;this.calibration.biasG={x:0,y:0,z:0};this.bias={x:0,y:0,z:0};this.scale={x:1,y:1,z:1};this.filter.reset();this._emit();return true;}
  resetStepCounter({today=true,total=false}={}){if(today){this.steps.today=0;this.steps.lastResetTs=Date.now();}if(total)this.steps.total=0;this._emit();return true;}
  getStepCount(){return{total:Math.floor(this.steps.total),today:Math.floor(this.steps.today),cadenceSpm:Number(this.steps.cadenceSpm.toFixed(1)),distanceM:Number(this.steps.walkingDistanceM.toFixed(1)),distanceKm:Number((this.steps.walkingDistanceM/1000).toFixed(3))};}
  simulateShake(durationMs=500,intensity=0.8){durationMs=Math.max(0,Number(durationMs)||0);intensity=clamp(Number(intensity)||0,0,1);this.detection.shake=true;this.detection.shakeIntensity=intensity;this.detection.lastShakeTs=Date.now();this.metrics.shakeEvents++;this._emit();setTimeout(()=>{this.detection.shake=false;this.detection.shakeIntensity=0;this._emit();},durationMs);return true;}
  simulateActivity(activity,durationMs=5000){if(!Object.values(Activity).includes(activity))return false;const prev=this.activity;this.activity=activity;this.activitySince=Date.now();this.metrics.activityChanges++;for(const fn of this.activitySubscribers){try{fn({activity,prev,since:this.activitySince,simulated:true});}catch(_) {}}if(durationMs>0)setTimeout(()=>{this.activity=prev;this.activitySince=Date.now();this._emit();},durationMs);this._emit();return true;}

  simulateImpact(magnitude=6.0){
    magnitude=Math.max(0,Number(magnitude)||0);
    const now=Date.now();
    this.detection.impact=true;
    this.detection.lastImpactTs=now;
    this.detection.peakG=Math.max(this.detection.peakG,magnitude);
    this.metrics.impactEvents++;
    logger.warn('VAccelerometer',`💥 impacto simulado (mag=${magnitude.toFixed(2)}g)`);
    const event={type:'impact',magnitude,simulated:true,timestamp:now};
    for(const fn of this.motionSubscribers){try{fn(event);}catch(_) {}}
    this.bus?.raiseInterrupt?.('IRQ_MOTION',{source:'vaccel',event:'impact',magnitude:Number(magnitude.toFixed(2)),simulated:true},'vaccel');
    this._emit();
    return event;
  }

  resetDetection(){this.detection.shake=false;this.detection.shakeIntensity=0;this.detection.lastShakeTs=null;this.detection.freeFall=false;this.detection.freeFallStart=null;this.detection.impact=false;this.detection.lastImpactTs=null;this.detection.peakG=0;this._freeFallStart=null;this._shakeStart=null;this._emit();return true;}
  setFilterAlpha(alpha){this.filter.setAlpha(Number(alpha));this._emit();return this.filter.alpha;}
  subscribe(fn){if(typeof fn!=='function')return()=>{};this.subscribers.add(fn);return()=>this.unsubscribe(fn);}
  unsubscribe(fn){return this.subscribers.delete(fn);}
  onOrientation(fn){if(typeof fn!=='function')return()=>{};this.orientationSubscribers.add(fn);return()=>this.orientationSubscribers.delete(fn);}
  onActivity(fn){if(typeof fn!=='function')return()=>{};this.activitySubscribers.add(fn);return()=>this.activitySubscribers.delete(fn);}
  onStep(fn){if(typeof fn!=='function')return()=>{};this.stepSubscribers.add(fn);return()=>this.stepSubscribers.delete(fn);}
  onMotion(fn){if(typeof fn!=='function')return()=>{};this.motionSubscribers.add(fn);return()=>this.motionSubscribers.delete(fn);}
  getCurrent(){return{...this.current};}
  getGravity(){return{...this.gravity};}
  getLinearAcceleration(){return{...this.linear};}
  getOrientation(){return this.orientation;}
  getActivity(){return this.activity;}
  getHistory(limit=this.history.length){limit=Math.max(0,Math.floor(Number(limit)||0));return this.history.last(Math.min(limit,this.history.length));}
  getMetrics(){return{...this.metrics,throughput:{...this.throughput},currentPowerMw:this.currentPowerMw,sampleRateHz:this.sampleRateHz,rangeG:this.rangeG,state:this.state,running:this.running,enabled:this.enabled};}
  getStatus(){return{name:this.name,model:this.model,state:this.state,initialized:this.initialized,running:this.running,enabled:this.enabled,lowPowerMode:this.lowPowerMode,rangeG:this.rangeG,sampleRateHz:this.sampleRateHz,orientation:this.orientation,activity:this.activity,steps:this.getStepCount(),detection:{...this.detection},powerMw:this.currentPowerMw};}
  _emit(){const payload={current:{...this.current},gravity:{...this.gravity},linear:{...this.linear},orientation:this.orientation,activity:this.activity,steps:this.getStepCount(),detection:{...this.detection},state:this.state,sampleRateHz:this.sampleRateHz,rangeG:this.rangeG,powerMw:this.currentPowerMw,timestamp:Date.now()};for(const fn of this.subscribers){try{fn(payload);}catch(_) {}}}
  destroy(){clearInterval(this.tickId);this.tickId=null;this.running=false;this.initialized=false;this.state=AccelState.OFF;this.subscribers.clear();this.orientationSubscribers.clear();this.activitySubscribers.clear();this.stepSubscribers.clear();this.motionSubscribers.clear();this.history.clear();this.detection={shake:false,shakeIntensity:0,lastShakeTs:null,freeFall:false,freeFallStart:null,impact:false,lastImpactTs:null,peakG:0};logger.info('VAccelerometer','destruido');}
}

export default VAccelerometer;
