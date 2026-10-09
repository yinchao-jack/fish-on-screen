const tabs=[...document.querySelectorAll('[role="tab"]')];
function activate(tab,focus=false) {
  tabs.forEach(t=>{
    const selected=t===tab;
    t.setAttribute('aria-selected',String(selected));t.tabIndex=selected?0:-1;
    document.getElementById(t.getAttribute('aria-controls')).hidden=!selected;
  });
  document.getElementById('settings-panel').scrollTop=0;
  if(focus)tab.focus();
}
tabs.forEach((t,i)=>{
  t.addEventListener('click',()=>activate(t));
  t.addEventListener('keydown',e=>{
    let target=null;
    if(e.key==='ArrowRight')target=tabs[(i+1)%tabs.length];
    if(e.key==='ArrowLeft')target=tabs[(i+tabs.length-1)%tabs.length];
    if(e.key==='Home')target=tabs[0];
    if(e.key==='End')target=tabs.at(-1);
    if(target){e.preventDefault();activate(target,true);}
  });
});
