// Local, opt-in playback. Custom files stay in the browser via object URLs.
const player = document.getElementById('background-audio');
const toggle = document.getElementById('music-toggle');
const source = document.getElementById('music-source');
const volume = document.getElementById('music-volume');
const status = document.getElementById('music-status');
const fileInput = document.getElementById('music-file');
const tracks = {sea:'./music/sea-notes.wav',moon:'./music/moon-drift.wav'};
let customURL = null;
let wanted = false;
let request = 0;

function reflect() {
  toggle.setAttribute('aria-pressed', String(wanted));
  toggle.textContent = wanted ? '关闭音乐' : '播放音乐';
  document.getElementById('music-indicator').textContent = wanted ? '音乐已开启' : '音乐已关闭';
}
function stop() { ++request; wanted=false; player.pause(); reflect(); }
async function play() {
  const current=++request; wanted=true; reflect();
  try {
    await player.play();
    if(current===request) status.textContent='正在播放 · '+source.selectedOptions[0].textContent;
  } catch(error) {
    if(current!==request)return;
    wanted=false;reflect();
    status.textContent='暂时无法播放，请选择其他音频或重试。';
  }
}
function changeSource(url) {
  const resume=wanted; ++request; player.pause();player.src=url;player.load();status.textContent='';
  if(resume) void play(); else reflect();
}
player.volume=0.25;
player.src=tracks.sea;
toggle.addEventListener('click',()=>{if(wanted){stop();status.textContent='';}else void play();});
source.addEventListener('change',()=>changeSource(source.value==='custom'?customURL:tracks[source.value]));
volume.addEventListener('input',()=>{
  player.volume=Number(volume.value)/100;
  document.getElementById('volume-value').value=volume.value+'%';
});
fileInput.addEventListener('change',()=>{
  const file=fileInput.files?.[0];
  if(!file)return;
  if(!(file.type.startsWith('audio/')||/\.(mp3|wav|m4a|aac|ogg|flac|aiff|aif)$/i.test(file.name))){
    status.textContent='请选择 MP3、WAV、M4A 等音频文件。';fileInput.value='';return;
  }
  const previous=customURL;
  customURL=URL.createObjectURL(file);
  let option=source.querySelector('[value="custom"]');
  if(!option){option=document.createElement('option');option.value='custom';source.appendChild(option);}
  option.textContent=file.name;
  source.value='custom';changeSource(customURL);
  if(previous)URL.revokeObjectURL(previous);
  document.getElementById('custom-file-name').textContent=file.name;
  fileInput.value='';
});
player.addEventListener('error',()=>{
  if(!wanted)return;
  stop();status.textContent='此音频无法播放，请更换文件。';
});
addEventListener('pagehide',event=>{stop();if(customURL&&!event.persisted)URL.revokeObjectURL(customURL);});
reflect();
