const $ = (selector, root=document) => root.querySelector(selector);
const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];
const persianDigits = value => String(value).replace(/\d/g, digit => '۰۱۲۳۴۵۶۷۸۹'[digit]);
let activeMode = 'video';
let selectedDuration = 15;
let selectedRatio = '16:9';
let toastTimer;
let sceneCounter = 3;

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3200);
}

function openModal(title, body, action='متوجه شدم') {
  $('#modalContent').innerHTML = `<div class="modal-symbol">✧</div><h3 id="modalTitle">${title}</h3><p>${body}</p><div class="modal-note"><span>ⓘ</span><span>کلید مدل‌ها نباید داخل اپ اندروید یا مرورگر ذخیره شود؛ اتصال‌ها باید فقط در سرور امن نگهداری شوند.</span></div><button class="modal-action" id="modalAction">${action}</button>`;
  $('#modalBackdrop').hidden = false;
  $('#modalAction').onclick = closeModal;
}
function closeModal(){ $('#modalBackdrop').hidden = true; }

function updateCounts() {
  for (const [id, countId, max] of [['videoPrompt','videoCount',900],['imagePrompt','imageCount',900],['audioPrompt','audioCount',1400]]) {
    const field = document.getElementById(id);
    const target = document.getElementById(countId);
    if (field && target) target.textContent = `${persianDigits(field.value.length)} / ${persianDigits(max)}`;
  }
}

function updatePreview() {
  const modeNames = {video:'ویدیو', image:'تصویر', audio:'صدا'};
  const costs = {video:Math.round(selectedDuration * 8), image:24, audio:36};
  const label = {video:'ساخت ویدیو',image:'ساخت تصویر',audio:'ساخت صدا'};
  $('#breadcrumbTitle').textContent = activeMode === 'video' ? 'خلق جدید' : `ساخت ${modeNames[activeMode]}`;
  $('#generateLabel').textContent = label[activeMode];
  $('#creditCost').innerHTML = `${persianDigits(costs[activeMode])} <small>اعتبار</small>`;
  const ratio = activeMode === 'image' ? ($('.mode-content[data-mode-content="image"] .ratio-picker .selected')?.dataset.ratio || '1:1') : selectedRatio;
  if (activeMode === 'video') {
    $('#previewDetail').textContent = `ویدیو · ${persianDigits(selectedDuration)} دقیقه · ${ratio}`;
    $('.preview-duration').textContent = `${persianDigits(selectedDuration)}:۰۰`;
  } else if (activeMode === 'image') {
    $('#previewDetail').textContent = `تصویر · ${ratio} · سینمایی`;
    $('.preview-duration').textContent = 'نمونه';
  } else {
    $('#previewDetail').textContent = 'صدا · گویندگی / موسیقی · نمونهٔ نمایشی';
    $('.preview-duration').textContent = '♫ صوت';
  }
}

function setMode(mode) {
  if (!['video','image','audio'].includes(mode)) return;
  activeMode = mode;
  $$('.mode-tab').forEach(button => {
    const selected = button.dataset.mode === mode;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  $$('.mode-content').forEach(content => {
    const selected = content.dataset.modeContent === mode;
    content.hidden = !selected;
    content.classList.toggle('active', selected);
  });
  $$('.mode-nav').forEach(button => button.classList.toggle('active', button.dataset.modeLink === mode));
  updatePreview();
  document.getElementById('create').scrollIntoView({behavior:'smooth',block:'start'});
}

$$('.mode-tab').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
$$('.mode-nav').forEach(button => button.addEventListener('click', () => setMode(button.dataset.modeLink)));
$$('textarea').forEach(field => field.addEventListener('input', updateCounts));

$$('.duration-choices button').forEach(button => button.addEventListener('click', () => {
  $$('.duration-choices button').forEach(item => item.classList.toggle('selected', item === button));
  selectedDuration = Number(button.dataset.duration);
  updatePreview();
}));
$$('.ratio-picker').forEach(group => $$('button', group).forEach(button => button.addEventListener('click', () => {
  $$('button', group).forEach(item => item.classList.toggle('selected', item === button));
  if (activeMode === 'video') selectedRatio = button.dataset.ratio;
  updatePreview();
})));

function makeSceneRow(number, title='سکانس تازه', note='جزئیات این بخش از روایت را بنویس') {
  const row = document.createElement('div');
  row.className = 'scene-row';
  const no = document.createElement('span'); no.className='scene-number'; no.textContent=persianDigits(String(number).padStart(2,'0'));
  const body = document.createElement('div'); body.className='scene-body';
  const heading = document.createElement('b'); heading.textContent=title;
  const detail = document.createElement('small'); detail.textContent=note;
  body.append(heading,detail);
  const time = document.createElement('span'); time.className='scene-time'; time.textContent='۰۰:۴۵';
  const remove = document.createElement('button'); remove.className='scene-menu'; remove.type='button'; remove.setAttribute('aria-label','حذف سکانس'); remove.textContent='×';
  remove.addEventListener('click',()=>{row.remove();renumberScenes();});
  row.append(no,body,time,remove);
  return row;
}
function renumberScenes(){ $$('.scene-row .scene-number').forEach((el,index)=>el.textContent=persianDigits(String(index+1).padStart(2,'0'))); }
$('#addScene').addEventListener('click',()=>{
  if ($('#sceneList').children.length >= 12) return toast('در این نمونه حداکثر ۱۲ سکانس قابل نمایش است.');
  sceneCounter += 1;
  const row = makeSceneRow(sceneCounter);
  $('#sceneList').append(row);
  const title = row.querySelector('b');
  title.contentEditable = 'true';
  title.setAttribute('aria-label','عنوان سکانس');
  title.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();title.blur();}});
  title.addEventListener('blur',()=>{if(!title.textContent.trim())title.textContent='سکانس تازه';});
  row.querySelector('small').contentEditable='true';
  toast('سکانس تازه به استوری‌بورد اضافه شد.');
});
$$('.scene-row .scene-menu').forEach(button=>button.addEventListener('click',()=>{
  const row=button.closest('.scene-row');
  if($('#sceneList').children.length<=1)return toast('استوری‌بورد باید دست‌کم یک سکانس داشته باشد.');
  row.remove();renumberScenes();toast('سکانس از استوری‌بورد حذف شد.');
}));

function bindUploader(inputId, zoneId, previewId) {
  const input = document.getElementById(inputId);
  const zone = document.getElementById(zoneId);
  if (!input || !zone) return;
  const handle = file => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('لطفاً یک فایل تصویری انتخاب کن.');
    if (file.size > 10 * 1024 * 1024) return toast('حجم تصویر باید کمتر از ۱۰ مگابایت باشد.');
    const preview = document.getElementById(previewId);
    const reader = new FileReader();
    reader.onload = () => { preview.src = reader.result; preview.hidden = false; zone.classList.add('has-image'); };
    reader.readAsDataURL(file);
    const copy = zone.querySelector('.upload-copy');
    copy.querySelector('b').textContent = file.name;
    copy.querySelector('small').textContent = 'تصویر مرجع آمادهٔ پیش‌نمایش است';
  };
  input.addEventListener('change',()=>handle(input.files?.[0]));
  zone.addEventListener('dragover',event=>{event.preventDefault();zone.classList.add('dragover');});
  zone.addEventListener('dragleave',()=>zone.classList.remove('dragover'));
  zone.addEventListener('drop',event=>{event.preventDefault();zone.classList.remove('dragover');handle(event.dataTransfer.files?.[0]);});
}
bindUploader('referenceImage','uploadZone','uploadPreview');
bindUploader('referenceImageImage','uploadZoneImage','uploadPreviewImage');

$$('[data-enhance]').forEach(button=>button.addEventListener('click',()=>{
  const field = document.getElementById(button.dataset.enhance);
  if (!field.value.trim()) return toast('اول یک ایده یا توضیح کوتاه بنویس.');
  toast('بهبود خودکار پرامپت پس از اتصال مدل در بک‌اند فعال می‌شود.');
}));
$('#enhancePrompt').addEventListener('click',()=>{
  if (!$('#videoPrompt').value.trim()) return toast('اول یک ایده یا توضیح کوتاه بنویس.');
  toast('بهبود خودکار پرامپت پس از اتصال مدل در بک‌اند فعال می‌شود.');
});

$$('.audio-type').forEach(button=>button.addEventListener('click',()=>{
  $$('.audio-type').forEach(item=>item.classList.toggle('selected',item===button));
  updatePreview();
}));
$$('#imageStyle,#videoStyle,#voiceStyle').forEach(select=>select.addEventListener('change',updatePreview));

$('#generateButton').addEventListener('click',()=>openModal('آمادهٔ اتصال مدل هستیم','این نسخه طراحی تعاملی اپ است و هنوز به سرویس تولید ویدیو، تصویر یا صوت متصل نیست؛ بنابراین خروجی واقعی نمی‌سازد. برای نسخهٔ عملیاتی باید مدل‌های موردنظر و شیوهٔ میزبانی بک‌اند مشخص شوند. کلید API را در اپ یا گفتگو وارد نکن؛ آن‌ها باید در Secretهای امن سرور نگهداری شوند.','باشه، متوجه شدم'));
$('#planInfo').addEventListener('click',()=>openModal('اعتبارهای نمایشی','عدد اعتبار فقط برای نمایش رابط کاربری است و به سرویس پرداخت یا مدل واقعی متصل نیست. پس از انتخاب مدل‌ها، مصرف هر سرویس باید در سرور محاسبه شود.'));
$('#creditInfo').addEventListener('click',()=>$('#planInfo').click());
$('#samplePlay').addEventListener('click',()=>toast('نمونهٔ صوتی نمایشی است؛ برای پخش باید مدل صوتی متصل شود.'));
$('#expandPreview').addEventListener('click',()=>toast('این قاب، پیش‌نمایش طراحی است و فایل ویدیویی هنوز تولید نشده است.'));
$('#downloadPreview').addEventListener('click',()=>toast('هنوز خروجی واقعی برای دانلودی وجود ندارد.'));
$('.hero-play').addEventListener('click',()=>toast('پیش‌نمایش پروژهٔ نمونه؛ این ویدیو در نسخهٔ طراحی‌شده تولید نشده است.'));
$('.cover-play').addEventListener('click',()=>toast('این کارت فقط نمونهٔ نمایشی است.'));
$('#allProjects').addEventListener('click',()=>toast('کتابخانهٔ پروژه‌ها در این نسخه نمایشی است.'));
$('#securityNote').addEventListener('click',event=>{event.preventDefault();openModal('حریم خصوصی و کلیدهای مدل','فایل‌های مرجع این نمونه فقط در مرورگر برای پیش‌نمایش محلی خوانده می‌شوند و آپلود نمی‌شوند. در نسخهٔ واقعی، انتقال فایل و کلیدها باید از مسیر HTTPS و بک‌اند امن انجام شود.');});
$('#promptTips').addEventListener('click',()=>openModal('چطور پرامپت دقیق‌تری بنویسی؟','سوژه و کنش اصلی را مشخص کن. بعد، نور، حال‌وهوا، حرکت دوربین و سبک بصری را توصیف کن. برای ویدیوی بلند، هر سکانس را با هدف روایی و پیوند آن با سکانس بعدی بنویس.'));
$('#mobileNew').addEventListener('click',()=>{setMode('video');document.getElementById('videoPrompt').focus({preventScroll:true});});
$('#newProject').addEventListener('click',()=>{setMode('video');document.getElementById('videoPrompt').focus({preventScroll:true});});
$('#resetForm').addEventListener('click',()=>{
  $$('textarea').forEach(field=>field.value='');
  for(const id of ['uploadPreview','uploadPreviewImage']){const image=document.getElementById(id);image.removeAttribute('src');image.hidden=true;}
  for(const id of ['uploadZone','uploadZoneImage']){const zone=document.getElementById(id);if(zone){zone.classList.remove('has-image');const copy=zone.querySelector('.upload-copy');copy.querySelector('b').textContent=id==='uploadZone'?'تصویر را انتخاب یا اینجا رها کن':'تصویر مرجع را انتخاب کن';copy.querySelector('small').textContent='JPG، PNG یا WEBP · حداکثر ۱۰ مگابایت';}}
  $('#referenceImage').value='';$('#referenceImageImage').value='';
  updateCounts();toast('فرم برای ایدهٔ تازه آماده شد.');
});
$('#modalClose').addEventListener('click',closeModal);
$('#modalBackdrop').addEventListener('click',event=>{if(event.target===$('#modalBackdrop'))closeModal();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeModal();if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();setMode('video');$('#videoPrompt').focus();}});

// Decorative waveform in the audio sample card; no audio is sent or synthesized.
const waveform=$('.waveform');
for(let i=0;i<43;i++){const bar=document.createElement('i');bar.style.height=`${5+((i*17+11)%17)}px`;waveform.append(bar);}
updateCounts();updatePreview();
