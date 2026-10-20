'use strict';
(() => {
  const channels = {
    desktop: {type:'NATIVE PAY',tag:'微信扫码',heading:'扫码付款，留在熟悉的网页。',detail:'电脑展示订单二维码，用户用微信扫一扫。支付中心确认到账后，把签名结果通知产品服务端。'},
    mobile: {type:'MOBILE WEB',tag:'按资质启用',heading:'让手机里的支付，也顺畅衔接。',detail:'微信内网页可接入 JSAPI 支付，需关联公众号与支付授权目录。手机外部浏览器的 H5 支付需单独申请开通；未开通时不会展示付款入口。'},
    client: {type:'CLIENT INTEGRATION',tag:'后端统一接入',heading:'客户端发起，服务端确认。',detail:'安卓与桌面客户端通过自己的后端创建订单，再打开统一收银台。安卓原生 APP 支付需额外开通并绑定移动应用 AppID；密钥始终保存在服务端。'}
  };
  const tabs = [...document.querySelectorAll('[data-channel]')];
  function selectTab(tab) {
    const content = channels[tab.dataset.channel];
    if (!content) return;
    for (const button of tabs) {
      const selected = button === tab;
      button.classList.toggle('active',selected);
      button.setAttribute('aria-selected',String(selected));
      button.tabIndex=selected?0:-1;
    }
    document.getElementById('channel-panel').setAttribute('aria-labelledby',tab.id);
    for (const [id,key] of [['channel-type','type'],['channel-tag','tag'],['channel-heading','heading'],['channel-detail','detail']]) document.getElementById(id).textContent=content[key];
  }
  tabs.forEach((tab,index)=>{
    tab.addEventListener('click',()=>selectTab(tab));
    tab.addEventListener('keydown',event=>{
      let next;
      if(event.key==='ArrowRight') next=(index+1)%tabs.length;
      if(event.key==='ArrowLeft') next=(index+tabs.length-1)%tabs.length;
      if(event.key==='Home') next=0;
      if(event.key==='End') next=tabs.length-1;
      if(next!==undefined){event.preventDefault();selectTab(tabs[next]);tabs[next].focus();}
    });
  });
  const title=document.getElementById('health-title');
  const detail=document.getElementById('health-detail');
  const label=document.getElementById('service-label');
  fetch('/api/health',{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(10000)})
    .then(async response=>{if(!response.ok)throw new Error();return response.json();})
    .then(data=>{
      if(data.service!=='brclio-pay')throw new Error();
      if(data.mode==='live'&&data.configured===true){
        document.getElementById('service-badge').classList.add('ready');
        label.textContent='实付模式 · 已配置';
        title.textContent='实付模式已配置';
        const names={native:'Native 扫码',jsapi:'JSAPI',h5:'H5',app:'APP'};
        const enabled=Array.isArray(data.channels)?data.channels.filter(c=>names[c]).map(c=>names[c]):[];
        detail.textContent=enabled.length?`服务端报告已启用：${enabled.join(' / ')}。正式收款前仍需完成真实付款验证。`:'服务端已配置；可用渠道以创建订单的结果为准。';
      }else{
        label.textContent=data.mode==='demo'?'演示模式 · 待配置':'实付配置未完成';
        title.textContent=data.mode==='demo'?'当前为演示模式，尚未启用真实收款':'微信支付配置尚未完成';
        detail.textContent='完成商户密钥、支付公钥与域名配置，并验证付款回调后，即可接入产品。';
      }
    })
    .catch(()=>{label.textContent='服务状态暂不可用';title.textContent='暂时无法确认服务状态';detail.textContent='页面仍可预览。请检查服务部署与网络连接后刷新。';});
})();
