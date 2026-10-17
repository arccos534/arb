(() => {
  const key='arbitrage-theme';
  let theme='dark';try{const saved=localStorage.getItem(key);if(saved==='light'||saved==='dark')theme=saved;}catch{}
  const apply=()=>{
    document.documentElement.dataset.theme=theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#101715':'#f5f6f3');
    const button=document.querySelector('[data-theme-toggle]');
    if(button){button.textContent=theme==='dark'?'☀ Светлая тема':'☾ Тёмная тема';button.setAttribute('aria-pressed',String(theme==='dark'));}
  };
  apply();document.addEventListener('DOMContentLoaded',apply);
  document.addEventListener('click',event=>{if(!event.target.closest('[data-theme-toggle]'))return;theme=theme==='dark'?'light':'dark';try{localStorage.setItem(key,theme);}catch{}apply();});
})();
