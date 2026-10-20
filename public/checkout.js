'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const states={CREATING:'正在创建订单',PENDING:'等待付款',SUCCESS:'支付成功',CLOSED:'订单已关闭',PAYERROR:'支付异常'};
  const match=location.pathname.match(/^\/checkout\/([^/]+)\/?$/);
  let orderId='';
  try{orderId=match?decodeURIComponent(match[1]):'';}catch{}
  const demo=orderId==='demo';
  let token='',order=null,timer=null,requesting=false,lastCode='',expired=false,bridgePaying=false,lastProviderRefresh=Date.now();
  const tokenKey=`brclio.checkout.${orderId}`;
  const fragmentToken=new URLSearchParams(location.hash.slice(1)).get('token');
  if(fragmentToken){token=fragmentToken;try{sessionStorage.setItem(tokenKey,token);}catch{}history.replaceState(null,'',location.pathname+location.search);}
  else{try{token=sessionStorage.getItem(tokenKey)||'';}catch{}}
  function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
  function qrPlaceholder(title,detail){$('qr-shell').hidden=false;$('qr-canvas').hidden=true;$('qr-placeholder').hidden=false;$('placeholder-title').textContent=title;$('placeholder-detail').textContent=detail;}
  function result(heading,detail){$('qr-shell').hidden=true;$('payment-caption').hidden=true;$('time-left').hidden=true;$('payment-method').hidden=true;$('status-result').hidden=false;$('result-heading').textContent=heading;$('result-detail').textContent=detail;}
  function safeReturn(raw){try{const url=new URL(raw);return url.protocol==='https:'?url.href:null;}catch{return null;}}
  function validOrder(data){return data&&typeof data.id==='string'&&data.id===orderId&&typeof data.description==='string'&&data.amount&&Number.isSafeInteger(data.amount.total)&&data.amount.total>=0&&data.amount.currency==='CNY'&&Object.hasOwn(states,data.status);}
  function updateExpiry(){
    if(!order||order.status!=='PENDING'||demo)return;
    const ends=Date.parse(order.expiresAt);
    if(!Number.isFinite(ends)){$('time-left').hidden=true;return;}
    const seconds=Math.max(0,Math.ceil((ends-Date.now())/1000));
    expired=seconds===0;
    $('time-left').hidden=false;
    if(expired){$('time-left').textContent='支付窗口已结束，请刷新确认最终结果。';$('pay-button').hidden=true;$('qr-shell').hidden=true;$('payment-caption').textContent='请刷新结果，或返回产品重新下单。';}
    else{$('time-left').textContent=`请在 ${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')} 内完成支付`;}
  }
  async function render(data){
    if(!validOrder(data))throw new Error('订单响应格式不正确，请稍后重试。');
    order=data;
    expired=false;
    $('order-client').textContent=data.clientName||'Brclio 产品';
    $('order-description').textContent=data.description;
    $('amount').textContent=(data.amount.total/100).toFixed(2);
    $('order-id').textContent=data.id;
    $('order-status').textContent=states[data.status];
    $('refresh-button').hidden=['SUCCESS','CLOSED','PAYERROR'].includes(data.status);
    $('return-button').hidden=true;$('pay-button').hidden=true;$('back-button').hidden=true;$('delivery-row').hidden=true;
    $('status-result').hidden=true;$('payment-method').hidden=false;$('payment-caption').hidden=false;
    $('time-left').hidden=true;
    if(data.status==='SUCCESS'){
      result('支付已确认',data.deliveryStatus==='delivered'?'付款结果已送达产品。返回后，请以产品的权益开通结果为准。':'付款已确认，正在通知产品。返回后，产品会再次核验并开通服务。');
      $('pay-step').classList.remove('current');$('pay-step').classList.add('done');$('pay-step').removeAttribute('aria-current');
      $('return-step').classList.add('current');$('return-step').setAttribute('aria-current','step');
      $('delivery-row').hidden=false;$('delivery-status').textContent=data.deliveryStatus==='delivered'?'已送达':data.deliveryStatus==='pending'?'正在通知':'以产品核验为准';
      const target=safeReturn(data.returnUrl);
      if(target){$('return-button').href=target;$('return-button').hidden=false;}else{$('back-button').hidden=false;}
      message('请勿重复付款。页面跳转本身不作为权益开通凭据。');
      return;
    }
    if(data.status==='CLOSED'||data.status==='PAYERROR'){
      result(data.status==='CLOSED'?'订单已关闭':'暂时无法完成付款',data.status==='CLOSED'?'这笔订单已结束，请返回原产品重新创建订单。':'请返回原产品查看订单，确认付款结果后再尝试。');
      $('back-button').hidden=false;message('如已扣款，请联系产品方核对订单，不要重复付款。');return;
    }
    if(data.status==='CREATING'){
      qrPlaceholder('正在准备支付','订单创建中，请稍候。');$('payment-caption').textContent='正在与微信支付确认下单结果';return;
    }
    const payment=data.payment||{};
    if(demo){
      $('demo-banner').hidden=false;$('amount-caption').textContent='演示金额 · 不发起真实收款';
      qrPlaceholder('这里将显示付款二维码','真实订单创建后，在本地生成微信付款二维码。演示页面不展示可付款二维码。');
      if(!$('qr-placeholder').querySelector('.demo-stamp')){const stamp=document.createElement('span');stamp.className='demo-stamp';stamp.textContent='PREVIEW';stamp.setAttribute('aria-hidden','true');$('qr-placeholder').prepend(stamp);$('qr-placeholder').querySelector('svg').setAttribute('hidden','');}
      $('payment-caption').textContent='此为界面预览，请勿转账';$('refresh-button').textContent='查看演示说明';$('order-status').textContent='演示 · 不可付款';$('foot-note').textContent='演示环境不会创建微信支付订单，也不会触发产品开通通知。';return;
    }
    if(payment.channel==='native'){
      $('method-name').textContent='微信扫码支付';
      $('payment-caption').textContent=/Android|iPhone|iPad/i.test(navigator.userAgent)?'请使用另一台设备的微信扫描二维码':'打开微信「扫一扫」，扫描二维码付款';
      if(typeof payment.codeUrl!=='string'||!payment.codeUrl){qrPlaceholder('二维码尚未准备好','请稍候，或点击下方按钮刷新结果。');}
      else if(lastCode!==payment.codeUrl){
        qrPlaceholder('正在生成二维码','二维码仅在此设备本地生成。');
        if(!window.QRCodeLib||typeof window.QRCodeLib.toCanvas!=='function'){qrPlaceholder('二维码组件加载失败','请刷新页面后重试；请勿向其他二维码转账。');}
        else{try{await window.QRCodeLib.toCanvas($('qr-canvas'),payment.codeUrl,{width:224,margin:1,errorCorrectionLevel:'M',color:{dark:'#1A1A2E',light:'#fefcf6'}});lastCode=payment.codeUrl;$('qr-placeholder').hidden=true;$('qr-canvas').hidden=false;}catch{qrPlaceholder('暂时无法展示二维码','请刷新订单后重试。');}}
      }else{$('qr-shell').hidden=false;$('qr-placeholder').hidden=true;$('qr-canvas').hidden=false;}
    }else if(payment.channel==='h5'){
      $('method-name').textContent='微信 H5 支付';qrPlaceholder('在微信中完成付款','点击下方按钮打开微信支付。完成后返回这里查询结果。');
      try{const url=new URL(payment.h5Url);if(url.protocol!=='https:'||url.hostname!=='wx.tenpay.com')throw new Error();$('pay-button').dataset.h5Url=url.href;$('pay-button').hidden=false;}catch{message('付款链接无效，请返回产品重新下单。',true);}
      $('payment-caption').textContent='请在手机浏览器打开并付款';
    }else if(payment.channel==='jsapi'){
      $('method-name').textContent='微信 JSAPI 支付';
      if(payment.context==='web'){
        qrPlaceholder('微信内付款','请在微信内打开此收银台，并点击下方按钮付款。');$('pay-button').hidden=false;$('pay-button').textContent='在微信内付款 ↗';$('payment-caption').textContent='付款结果以服务端核验为准';
      }else{qrPlaceholder('请返回小程序付款','这笔订单需要在关联的小程序中调起微信支付。');$('payment-caption').textContent='请回到发起订单的小程序完成付款';}
    }else if(payment.channel==='app'){
      $('method-name').textContent='微信 APP 支付';qrPlaceholder('请返回应用继续付款','这笔订单需要由发起订单的应用调起微信支付。');$('payment-caption').textContent='付款后，应用将通过服务端确认结果';
    }else{qrPlaceholder('正在准备付款方式','请稍候，或刷新订单确认可用的支付方式。');}
    updateExpiry();
  }
  async function load(refresh=false,manual=false){
    if(demo){if(refresh)message('这是收银台界面预览。真实订单将展示微信返回的付款二维码，并由服务端核验付款结果。');return;}
    if(requesting)return;
    requesting=true;$('refresh-button').disabled=true;
    if(refresh)lastProviderRefresh=Date.now();
    if(refresh&&manual)message('正在向微信支付核对订单，请稍候。');
    try{
      const response=await fetch(`/api/checkout/${encodeURIComponent(orderId)}${refresh?'/refresh':''}`,{method:refresh?'POST':'GET',headers:{Authorization:`Bearer ${token}`},cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(15000)});
      const data=await response.json().catch(()=>null);
      if(!response.ok){if(response.status===401||response.status===403)throw new Error('收银台链接已失效，请返回产品重新下单。');throw new Error(typeof data?.error?.message==='string'?data.error.message:typeof data?.message==='string'?data.message:'暂时无法查询订单，请稍后重试。');}
      await render(data);
      if(data.status==='PENDING'&&refresh&&manual)message('暂未确认到账，页面会继续自动查询。已付款时请勿重复支付。');
      else if(data.status!=='SUCCESS')message('');
    }catch(error){message(error.name==='TimeoutError'?'查询超时，请检查网络后重试。':error.message||'暂时无法查询订单，请稍后重试。',true);if(!order){qrPlaceholder('暂时无法读取订单','请检查订单链接或稍后刷新。');$('order-client').textContent='订单读取失败';$('order-description').textContent='请确认收银台链接';$('order-status').textContent='查询失败';}}
    finally{requesting=false;$('refresh-button').disabled=false;schedule();}
  }
  function schedule(){
    clearTimeout(timer);
    const awaitingDelivery=order?.status==='SUCCESS'&&order.deliveryStatus==='pending';
    if(!document.hidden&&(!order||['CREATING','PENDING'].includes(order.status)||awaitingDelivery))timer=setTimeout(()=>{
      const reconcile=order?.status==='PENDING'&&Date.now()-lastProviderRefresh>=30000;
      load(reconcile);
    },4000);
  }
  function invokeBridge(){
    if(bridgePaying||!order||order.status!=='PENDING'||expired)return;
    const p=order.payment?.jsapi;
    if(!p||typeof p.appId!=='string'||typeof p.timeStamp!=='string'||typeof p.nonceStr!=='string'||typeof p.package!=='string'||!p.package.startsWith('prepay_id=')||p.signType!=='RSA'||typeof p.paySign!=='string'){message('微信支付参数不完整，请刷新订单或返回产品重试。',true);return;}
    if(!window.WeixinJSBridge||typeof window.WeixinJSBridge.invoke!=='function'){message('请在微信内置浏览器中打开此订单链接。',true);return;}
    bridgePaying=true;$('pay-button').disabled=true;
    try{window.WeixinJSBridge.invoke('getBrandWCPayRequest',{appId:p.appId,timeStamp:p.timeStamp,nonceStr:p.nonceStr,package:p.package,signType:p.signType,paySign:p.paySign},()=>{bridgePaying=false;$('pay-button').disabled=false;message('正在确认付款结果。');load(true);});}
    catch{bridgePaying=false;$('pay-button').disabled=false;message('微信支付暂未就绪，请稍候再试。',true);}
  }
  $('refresh-button').addEventListener('click',()=>load(true,true));
  $('pay-button').addEventListener('click',()=>{if(!order||order.status!=='PENDING'||expired)return;if(order.payment?.channel==='h5'){const target=$('pay-button').dataset.h5Url;if(target)location.assign(target);}else if(order.payment?.channel==='jsapi'&&order.payment.context==='web')invokeBridge();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(timer);else if(!demo&&token)load(false);});
  window.addEventListener('pagehide',()=>clearTimeout(timer));
  if(demo){orderId='demo';render({id:'demo',description:'Brclio 产品 · 收银台预览',amount:{total:1,currency:'CNY'},status:'PENDING',clientName:'Brclio Demo',payment:{channel:'native'},deliveryStatus:null});}
  else if(!orderId||!token){result('请使用完整订单链接','请从产品的付款入口打开此收银台。链接缺少订单凭证，请返回产品重新获取。');$('order-client').textContent='无法读取订单';$('order-description').textContent='订单链接不完整';$('order-status').textContent='缺少凭证';$('refresh-button').hidden=true;$('back-button').hidden=false;}
  else{load(false);setInterval(updateExpiry,1000);}
})();
