// The pilot moves the existing feed and OHLCV controls; it owns no acquisition,
// analyst runtime or independent feed subscription.
const preference = 'ogid:market-terminal';
export function mountMarketTerminal({onChange = () => {}} = {}) {
  const main = document.querySelector('main');
  const feed = document.getElementById('panel-news');
  const market = document.getElementById('panel-market');
  if (!main || !feed || !market) return {active:false, destroy(){}};
  const workspace = document.createElement('div');
  workspace.className = 'market-terminal';
  workspace.hidden = true;
  workspace.innerHTML = '<section class="panel terminal-chart-panel" aria-label="Gráfico por instrumento"><header class="panel-header"><h2 class="panel-title">Mercado por instrumento</h2><p>Datos almacenados · La selección no solicita descargas al proveedor.</p></header><div data-chart-slot></div><p class="terminal-attribution">TradingView Lightweight Charts™ · Copyright (с) 2025 TradingView, Inc. <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">TradingView</a></p></section><div data-feed-slot></div><section class="panel terminal-analyst-placeholder"><h2 class="panel-title">Análisis bajo demanda</h2><p>El Analista está disponible en la vista clásica. El gráfico y las noticias funcionan con la IA apagada.</p><button type="button" data-classic class="btn btn-sm btn-outline-info">Abrir vista clásica</button></section>';
  main.prepend(workspace);
  const connection = document.createElement('p');
  connection.id = 'terminal-connection-status';
  connection.setAttribute('role', 'status');
  workspace.querySelector('.terminal-chart-panel header').append(connection);
  const setConnection = connected => {connection.textContent = connected
    ? 'Actualizaciones conectadas · La fecha de la última vela indica la cobertura disponible.'
    : 'Actualización en espera · Se conservan los últimos datos almacenados.';};
  setConnection(false);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'view-nav-link';
  toggle.textContent = 'Terminal';
  toggle.setAttribute('aria-pressed', 'false');
  document.querySelector('.view-nav')?.append(toggle);
  const moved = [market.querySelector('.market-ohlcv-header'), market.querySelector('.market-ohlcv-chart-wrap'), document.getElementById('market-ohlcv-summary'), feed].filter(Boolean).map(node => {
    const marker = document.createComment('terminal return position');
    node.before(marker);
    return {node,marker};
  });
  let active = false;
  const set = value => {
    active = Boolean(value);
    workspace.hidden = !active;
    main.classList.toggle('terminal-active', active);
    toggle.setAttribute('aria-pressed', String(active));
    for (const {node,marker} of moved) {
      if (active) workspace.querySelector(node===feed?'[data-feed-slot]':'[data-chart-slot]').append(node);
      else marker.after(node);
    }
    try { localStorage.setItem(preference, active?'1':'0'); } catch { /* Optional browser preference. */ }
    onChange(active);
  };
  toggle.onclick = () => set(!active);
  workspace.querySelector('[data-classic]').onclick = () => {set(false);toggle.focus();};
  let saved = false;
  try {saved = localStorage.getItem(preference)==='1';} catch { /* Classic remains available. */ }
  if (saved) set(true);
  return {get active(){return active;},setConnection,destroy(){set(false);for(const {marker} of moved)marker.remove();workspace.remove();toggle.remove();}};
}

let library;
export function loadTerminalChartLibrary() {
  if (globalThis.LightweightCharts) return Promise.resolve(globalThis.LightweightCharts);
  if (!library) library = new Promise((resolve,reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/lightweight-charts-5.3.0/lightweight-charts.standalone.production.js';
    script.onload = () => resolve(globalThis.LightweightCharts);
    script.onerror = () => {script.remove();library=null;reject(Error('No se pudo cargar el gráfico.'));};
    document.head.append(script);
  });
  return library;
}

export function renderTerminalChart(container, candles, interval, library) {
  container.replaceChildren();
  const plot=document.createElement('div');container.append(plot);
  const chart = library.createChart(plot, {height:360,layout:{background:{type:'solid',color:'#10171e'},textColor:'#c5d0dc',attributionLogo:true},grid:{vertLines:{color:'#202b36'},horzLines:{color:'#202b36'}},timeScale:{timeVisible:interval!=='1day'}});
  const series = chart.addSeries(library.CandlestickSeries, {upColor:'#3cbfa4',downColor:'#ed7d82',borderVisible:false,wickUpColor:'#3cbfa4',wickDownColor:'#ed7d82'});
  const volumes = chart.addSeries(library.HistogramSeries, {priceFormat:{type:'volume'},priceScaleId:'volume'});
  chart.priceScale('volume').applyOptions({scaleMargins:{top:.82,bottom:0}});
  const time = row => interval==='1day'?row.openTime.slice(0,10):Math.floor(Date.parse(row.openTime)/1000);
  const controls=document.createElement('div');controls.className='agent-chat-controls';
  for(const [label,factor] of [['Acercar',.75],['Alejar',1.25],['Ajustar',null]]){
    const button=document.createElement('button');button.type='button';button.className='btn btn-sm btn-outline-light';button.textContent=label;
    button.onclick=()=>{if(factor===null){chart.timeScale().fitContent();return;}const range=chart.timeScale().getVisibleLogicalRange();if(range){const middle=(range.from+range.to)/2,half=(range.to-range.from)*factor/2;chart.timeScale().setVisibleLogicalRange({from:middle-half,to:middle+half});}};
    controls.append(button);
  }
  container.append(controls);
  const details=document.createElement('details'),summary=document.createElement('summary'),scroll=document.createElement('div'),table=document.createElement('table');
  summary.textContent='Consultar valores OHLCV';scroll.className='terminal-series-table';scroll.tabIndex=0;
  const header=table.createTHead().insertRow();
  for(const name of ['Fecha','Apertura','Máximo','Mínimo','Cierre','Volumen']){const th=document.createElement('th');th.scope='col';th.textContent=name;header.append(th);}
  const body=table.createTBody();
  const update = rows => {
    series.setData(rows.map(row => ({time:time(row),open:row.open,high:row.high,low:row.low,close:row.close})));
    volumes.setData(rows.filter(row=>row.volume!==null).map(row=>({time:time(row),value:row.volume,color:row.close>=row.open?'#3cbfa460':'#ed7d8260'})));
    body.replaceChildren();
    for(const candle of rows){const row=body.insertRow();for(const value of [candle.openTime,candle.open,candle.high,candle.low,candle.close,candle.volume??'Sin dato'])row.insertCell().textContent=String(value);}
  };
  update(candles);
  chart.timeScale().fitContent();
  scroll.append(table);details.append(summary,scroll);container.append(details);
  const resize = new ResizeObserver(() => chart.applyOptions({width:container.clientWidth}));
  resize.observe(container);
  chart.applyOptions({width:container.clientWidth});
  return {update,destroy(){resize.disconnect();chart.remove();container.replaceChildren();}};
}
