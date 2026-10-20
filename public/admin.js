'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const channelNames={native:'Native 扫码',jsapi:'JSAPI',h5:'H5',app:'APP'};
  let session=null,clients=[],availableChannels=['native'],editingId=null,skillText='',skillFilename='SKILL.md',requestBusy=false;
  function feedback(id,text,type=''){$(id).textContent=text;$(id).classList.toggle('error',type==='error');$(id).classList.toggle('success',type==='success');}
  function showLogin(){session=null;clients=[];$('client-list').replaceChildren();$('workspace-view').hidden=true;$('loading-view').hidden=true;$('login-view').hidden=false;$('logout-button').hidden=true;$('session-email').hidden=true;if($('client-dialog').open)$('client-dialog').close();if($('skill-dialog').open)$('skill-dialog').close();clearSkill();}
  function showWorkspace(){$('login-view').hidden=true;$('loading-view').hidden=true;$('workspace-view').hidden=false;$('logout-button').hidden=false;$('session-email').hidden=false;$('session-email').textContent=session.email;$('login-password').value='';}
  async function api(path,{method='GET',body,login=false}={}){
    const headers={Accept:'application/json'};
    if(body!==undefined)headers['Content-Type']='application/json';
    if(method!=='GET'&&!login){if(!session?.csrfToken)throw new Error('管理员会话已失效，请重新登录。');headers['X-Brclio-CSRF']=session.csrfToken;}
    const response=await fetch(`/api/admin${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(20000)});
    const data=await response.json().catch(()=>null);
    if(!response.ok){if(response.status===401&&!login)showLogin();const error=new Error(typeof data?.error?.message==='string'?data.error.message:response.status===401?'邮箱或密码不正确，或会话已失效。':'操作暂未完成，请稍后重试。');error.status=response.status;throw error;}
    return data;
  }
  function button(label,className,handler){const el=document.createElement('button');el.type='button';el.className=className;el.textContent=label;el.addEventListener('click',handler);return el;}
  function textEl(tag,className,value){const el=document.createElement(tag);if(className)el.className=className;el.textContent=value;return el;}
  async function loadClients(){
    try{const data=await api('/clients');if(!data||!Array.isArray(data.clients))throw new Error('产品列表格式异常，请刷新页面。');clients=data.clients;availableChannels=Array.isArray(data.channels)?data.channels.filter(c=>channelNames[c]):['native'];renderClients();}
    catch(error){if(session)feedback('workspace-message',error.message,'error');}
  }
  function renderClients(){
    $('client-list').replaceChildren();$('client-count').textContent=`${clients.length} 个产品`;$('clients-empty').hidden=clients.length!==0;
    for(const client of clients){
      const card=document.createElement('article');card.className='client-card';
      const top=document.createElement('div');top.className='client-card-top';const title=document.createElement('div');title.append(textEl('h3','',client.name||client.id),textEl('p','client-id',client.id));top.append(title,textEl('span',`client-status${client.disabled?' disabled':''}`,client.disabled?'新订单已暂停':'接入已配置'));card.append(top);
      const products=Object.values(client.products||{});const meta=document.createElement('div');meta.className='client-card-meta';meta.append(textEl('span','',`${products.length} 个商品`));for(const channel of client.channels||[])if(channelNames[channel])meta.append(textEl('span','',channelNames[channel]));if(typeof client.maskedKey==='string')meta.append(textEl('span','',`密钥 ${client.maskedKey}`));card.append(meta);
      const webhook=textEl('p','client-webhook','');webhook.append(textEl('strong','','结果通知'),document.createTextNode(client.webhookUrl||'未配置'));card.append(webhook);
      const actions=document.createElement('div');actions.className='client-card-actions';const skillActions=document.createElement('div');const copyButton=button('复制接入 Skill ⧉','client-action client-skill-action',()=>copyClientSkill(client.id,copyButton));const downloadButton=button('下载 Skill ↓','client-action',()=>downloadClientSkill(client.id,downloadButton));skillActions.append(copyButton,downloadButton);
      const editActions=document.createElement('div');const editButton=button('编辑产品','client-action',()=>openClient(client));const rotateButton=button('轮换密钥','client-action rotate',()=>{confirm.hidden=!confirm.hidden;if(!confirm.hidden)cancelRotate.focus();});editActions.append(editButton,rotateButton);actions.append(skillActions,editActions);card.append(actions);
      const confirm=document.createElement('div');confirm.className='rotate-confirm';confirm.hidden=true;confirm.append(textEl('p','',`重新生成「${client.name||client.id}」的接口密钥与通知密钥后，新凭证会在约 15 秒内生效，旧凭证随后失效。请同步更新该产品的服务端配置，期间新请求与通知验签可能中断。确认后可重新复制 Skill。`));const rotateActions=document.createElement('div');rotateActions.className='rotate-buttons';const cancelRotate=button('保留现有密钥','button button-secondary',()=>{confirm.hidden=true;rotateButton.focus();});const performRotate=button('确认轮换这款产品的密钥','button button-primary',async()=>{performRotate.disabled=true;try{await api(`/clients/${encodeURIComponent(client.id)}/rotate`,{method:'POST',body:{}});feedback('workspace-message',`「${client.name||client.id}」密钥已轮换，请重新复制接入 Skill 并更新产品服务端。`,'success');await loadClients();}catch(error){if(session)feedback('workspace-message',error.message,'error');}finally{performRotate.disabled=false;}});rotateActions.append(cancelRotate,performRotate);confirm.append(rotateActions);card.append(confirm);$('client-list').append(card);
    }
  }
  async function fetchSkill(clientId){const data=await api(`/clients/${encodeURIComponent(clientId)}/skill`);if(!data||typeof data.content!=='string'||!data.content.trim())throw new Error('接入 Skill 尚未生成，请稍后再试。');return {content:data.content,filename:typeof data.filename==='string'?data.filename:'SKILL.md'};}
  function clearSkill(){skillText='';skillFilename='SKILL.md';$('skill-content').value='';$('skill-expiry').hidden=true;$('skill-expiry').textContent='';feedback('skill-message','');}
  function expiryNote(expiresAt){const date=new Date(expiresAt);return Number.isFinite(date.getTime())?`授权截止：${new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date)}（北京时间）。`:'';}
  function previewSkill(skill,message){skillText=skill.content;skillFilename=skill.filename;$('skill-content').value=skillText;$('skill-dialog-title').textContent=skill.title||'产品接入 Skill';const expiry=expiryNote(skill.expiresAt);$('skill-expiry').textContent=expiry;$('skill-expiry').hidden=!expiry;feedback('skill-message',message||'');$('skill-dialog').showModal();}
  async function copyBootstrapSkill(trigger){
    if(!session)return;
    trigger.disabled=true;feedback('workspace-message','正在生成这款产品专属的 24 小时接入授权…');
    try{
      const data=await api('/bootstrap-skill');
      if(!session)return;
      if(!data||typeof data.content!=='string'||!data.content.trim())throw new Error('自动接入 Skill 尚未生成，请稍后重试。');
      const skill={content:data.content,filename:typeof data.filename==='string'?data.filename:'SKILL.md',expiresAt:data.expiresAt,title:'自动接入 Skill'};
      try{await navigator.clipboard.writeText(skill.content);feedback('workspace-message',`自动接入 Skill 已复制。请交给已有项目代码与部署权限的 AI。${expiryNote(skill.expiresAt)}`,'success');}
      catch{previewSkill(skill,'浏览器未允许自动复制。请使用下方复制或下载按钮，把 Skill 交给已有项目权限的 AI。');feedback('workspace-message','自动接入 Skill 已准备好，授权仅限一款产品。');}
    }catch(error){if(session)feedback('workspace-message',error.message,'error');}
    finally{trigger.disabled=false;}
  }
  async function copyClientSkill(clientId,trigger){
    trigger.disabled=true;feedback('workspace-message','正在生成该产品的接入 Skill…');
    try{const skill=await fetchSkill(clientId);try{await navigator.clipboard.writeText(skill.content);feedback('workspace-message','接入 Skill 已复制。请交给有权限维护这款产品的开发助手；文件含该产品的服务端凭证。','success');}catch{previewSkill(skill,'浏览器未允许自动复制。点击下方复制按钮，或选中文本后复制。');feedback('workspace-message','接入 Skill 已准备好。');}}
    catch(error){if(session)feedback('workspace-message',error.message,'error');}finally{trigger.disabled=false;}
  }
  function downloadSkill(content,filename){const blob=new Blob([content],{type:'text/markdown;charset=utf-8'});const url=URL.createObjectURL(blob);const anchor=document.createElement('a');anchor.href=url;anchor.download=filename.replace(/[^a-zA-Z0-9._-]/g,'_')||'SKILL.md';document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function downloadClientSkill(clientId,trigger){trigger.disabled=true;try{const skill=await fetchSkill(clientId);downloadSkill(skill.content,skill.filename);feedback('workspace-message','已生成 Skill 下载文件。文件含该产品的服务端凭证，请妥善保管。','success');}catch(error){if(session)feedback('workspace-message',error.message,'error');}finally{trigger.disabled=false;}}
  function makeField(labelText,type,value,placeholder){const label=textEl('label','admin-field',labelText);const input=document.createElement('input');input.type=type;input.value=value;input.placeholder=placeholder;input.required=true;label.append(input);return {label,input};}
  function addSku(sku='',product={}){
    const row=document.createElement('div');row.className='sku-row';const head=document.createElement('div');head.className='sku-row-header';head.append(textEl('span','sku-number','商品'));const remove=button('移除','remove-sku',()=>{if($('sku-list').children.length<=1){feedback('client-form-message','每个产品至少需要配置一个商品。','error');return;}row.remove();numberSkus();});head.append(remove);row.append(head);
    const fields=document.createElement('div');fields.className='sku-fields';
    const skuField=makeField('商品编码','text',sku,'例如：monthly');skuField.input.dataset.field='sku';skuField.input.maxLength=80;skuField.input.pattern='[a-zA-Z0-9_\\-]+';skuField.input.autocomplete='off';
    const descriptionField=makeField('商品名称','text',product.description||'','例如：月度会员');descriptionField.input.dataset.field='description';descriptionField.input.maxLength=100;
    const price=Number.isSafeInteger(product.amount)?`${Math.floor(product.amount/100)}.${String(product.amount%100).padStart(2,'0')}`:'';const priceField=makeField('价格（元）','text',price,'0.00');priceField.input.dataset.field='price';priceField.input.inputMode='decimal';priceField.input.pattern='(?:0|[1-9][0-9]{0,6})(?:\\.[0-9]{1,2})?';
    const quantityField=makeField('数量上限','number',String(product.maxQuantity||1),'1');quantityField.input.dataset.field='quantity';quantityField.input.min='1';quantityField.input.max='100';quantityField.input.step='1';
    for(const field of [skuField,descriptionField,priceField,quantityField])fields.append(field.label);row.append(fields);$('sku-list').append(row);numberSkus();return row;
  }
  function numberSkus(){[...$('sku-list').children].forEach((row,index)=>{row.querySelector('.sku-number').textContent=`商品 ${String(index+1).padStart(2,'0')}`;row.querySelector('.remove-sku').disabled=$('sku-list').children.length===1;});}
  function openClient(client=null){
    editingId=client?.id||null;$('client-form').reset();feedback('client-form-message','');$('client-dialog-title').textContent=client?'编辑接入产品':'添加接入产品';$('client-dialog-eyebrow').textContent=client?'EDIT PRODUCT':'NEW PRODUCT';$('client-name').value=client?.name||'';$('client-id').value=client?.id||'';$('client-id').disabled=!!client;$('client-webhook').value=client?.webhookUrl||'';$('client-origins').value=(client?.returnOrigins||[]).join('\n');$('client-disabled').checked=!!client?.disabled;$('save-note').textContent=client?'保存配置不会更换现有密钥。':'创建后会自动生成独立的接口与通知密钥。';
    $('channel-options').replaceChildren();const channelUnion=[...new Set([...availableChannels,...(client?.channels||[])])];for(const channel of channelUnion){if(!channelNames[channel])continue;const label=document.createElement('label');label.className='checkbox-label';const input=document.createElement('input');input.type='checkbox';input.name='payment-channel';input.value=channel;input.checked=client?(client.channels||[]).includes(channel):channel==='native';const open=availableChannels.includes(channel);if(!open){input.disabled=true;label.title='服务端当前未开放此渠道';}label.append(input,document.createTextNode(`${channelNames[channel]}${open?'':'（未开放）'}`));$('channel-options').append(label);}
    $('sku-list').replaceChildren();const skus=Object.entries(client?.products||{});if(skus.length)for(const [sku,product] of skus)addSku(sku,product);else addSku();$('client-dialog').showModal();$('client-name').focus();
  }
  function collectClient(){
    const id=editingId||$('client-id').value.trim();if(!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id))throw new Error('产品标识需为 2–64 位小写字母、数字、下划线或短横线，且以字母或数字开头。');
    const name=$('client-name').value.trim();if(!name)throw new Error('请填写产品名称。');
    const webhookUrl=$('client-webhook').value.trim();let webhook;try{webhook=new URL(webhookUrl);}catch{throw new Error('请填写完整的付款通知 HTTPS 地址。');}if(webhook.protocol!=='https:'||webhook.username||webhook.password)throw new Error('付款结果通知地址必须使用 HTTPS，且不能包含账号密码。');
    const returnOrigins=[...new Set($('client-origins').value.split(/[\n,]/).map(value=>value.trim().replace(/\/$/,'')).filter(Boolean))];if(!returnOrigins.length||returnOrigins.some(origin=>!/^https:\/\/(?:\*\.)?[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(origin)))throw new Error('请按每行一个填写 HTTPS 来源，例如 https://app.brclio.com，不含路径。');
    const channels=[...$('channel-options').querySelectorAll('input:checked')].map(input=>input.value);if(!channels.length)throw new Error('请至少选择一个已开放的支付渠道。');
    const products=Object.create(null);for(const row of $('sku-list').children){const sku=row.querySelector('[data-field="sku"]').value.trim();const description=row.querySelector('[data-field="description"]').value.trim();const price=row.querySelector('[data-field="price"]').value.trim();const maxQuantity=Number(row.querySelector('[data-field="quantity"]').value);if(!/^[a-zA-Z0-9_-]{1,80}$/.test(sku))throw new Error('商品编码只能包含字母、数字、下划线或短横线，最多 80 位。');if(Object.hasOwn(products,sku))throw new Error(`商品编码「${sku}」重复，请修改。`);if(!description||new TextEncoder().encode(description).length>100)throw new Error(`商品「${sku}」名称不能为空，且不得超过 100 字节（约 33 个汉字）。`);if(!/^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,2})?$/.test(price))throw new Error(`商品「${sku}」价格需使用人民币元，最多两位小数。`);const [yuan,fraction='']=price.split('.');const amount=Number(yuan)*100+Number(fraction.padEnd(2,'0'));if(!Number.isSafeInteger(amount)||amount<1||amount>100000000)throw new Error(`商品「${sku}」价格需为 0.01 至 1,000,000.00 元。`);if(!Number.isInteger(maxQuantity)||maxQuantity<1||maxQuantity>100)throw new Error(`商品「${sku}」数量上限需为 1–100 的整数。`);products[sku]={description,amount,maxQuantity};}
    if(!Object.keys(products).length)throw new Error('请至少添加一个商品。');return {id,name,webhookUrl,returnOrigins,channels,products,disabled:$('client-disabled').checked};
  }
  $('login-form').addEventListener('submit',async event=>{event.preventDefault();if(requestBusy)return;requestBusy=true;$('login-button').disabled=true;feedback('login-message','正在验证账号…');try{const data=await api('/login',{method:'POST',login:true,body:{email:$('login-email').value.trim(),password:$('login-password').value}});if(typeof data?.email!=='string'||typeof data?.csrfToken!=='string')throw new Error('会话响应异常，请重试。');session={email:data.email,csrfToken:data.csrfToken};showWorkspace();feedback('login-message','');await loadClients();}catch(error){feedback('login-message',error.name==='TimeoutError'?'连接超时，请稍后重试。':error.message,'error');}finally{requestBusy=false;$('login-button').disabled=false;}});
  $('logout-button').addEventListener('click',async()=>{$('logout-button').disabled=true;try{await api('/logout',{method:'POST',body:{}});showLogin();feedback('login-message','已安全退出。');}catch(error){if(session)feedback('workspace-message',error.message,'error');}finally{$('logout-button').disabled=false;}});
  $('bootstrap-skill-button').addEventListener('click',()=>copyBootstrapSkill($('bootstrap-skill-button')));$('empty-bootstrap-button').addEventListener('click',()=>copyBootstrapSkill($('empty-bootstrap-button')));$('new-client-button').addEventListener('click',()=>openClient());$('add-sku-button').addEventListener('click',()=>{const row=addSku();row.querySelector('input').focus();});
  for(const id of ['close-client-dialog','cancel-client-dialog'])$(id).addEventListener('click',()=>$('client-dialog').close());$('close-skill-dialog').addEventListener('click',()=>$('skill-dialog').close());$('skill-dialog').addEventListener('close',clearSkill);
  $('copy-skill-button').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(skillText);feedback('skill-message','接入 Skill 已复制。请仅交给有权限维护该产品的开发助手。','success');}catch{$('skill-content').focus();$('skill-content').select();feedback('skill-message','请使用系统复制快捷键复制已选中的 Skill。');}});$('download-skill-button').addEventListener('click',()=>{if(skillText)downloadSkill(skillText,skillFilename);});
  $('client-form').addEventListener('submit',async event=>{event.preventDefault();if(requestBusy)return;let payload;try{payload=collectClient();}catch(error){feedback('client-form-message',error.message,'error');return;}requestBusy=true;$('save-client-button').disabled=true;feedback('client-form-message','正在保存产品配置…');try{await api('/clients',{method:'POST',body:payload});$('client-dialog').close();feedback('workspace-message',`「${payload.name}」配置已保存。可复制接入 Skill，继续开发这款产品。`,'success');await loadClients();}catch(error){if(session)feedback('client-form-message',error.message,'error');}finally{requestBusy=false;$('save-client-button').disabled=false;}});
  (async()=>{try{const data=await api('/session');if(typeof data?.email!=='string'||typeof data?.csrfToken!=='string')throw new Error('会话响应异常，请重新登录。');session={email:data.email,csrfToken:data.csrfToken};showWorkspace();await loadClients();}catch(error){showLogin();if(error.status!==401)feedback('login-message',error.name==='TimeoutError'?'暂时无法连接管理服务，请稍后重试。':error.message,'error');}})();
})();
