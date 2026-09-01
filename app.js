const $ = (id) => document.getElementById(id);
let currentUser = null;
let studentsData = [];
let reportRows = [];
let chart = null;
let boysChart = null, girlsChart = null, deptChart = null;
let currentSemesterCache = "Odd";

// ==========================================================
// "Attendance Day" helpers — the day resets fresh at 6:00 AM
// (not midnight), so late-night edge cases don't spill into
// the wrong day. Uses LOCAL date parts (not toISOString) so
// timezone never shifts the calendar day.
// ==========================================================
const ATTENDANCE_DAY_CUTOFF_HOUR = 6;

function getAttendanceNow(){
  const now = new Date();
  if(now.getHours() < ATTENDANCE_DAY_CUTOFF_HOUR){
    now.setDate(now.getDate() - 1);
  }
  return now;
}
function formatLocalDate(d){
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,"0"), day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function getAttendanceDateStr(){
  return formatLocalDate(getAttendanceNow());
}
let deferredPrompt = null;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js");
  });
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = $("installBtn");
  if (btn) btn.classList.remove("hidden");
});

// Admin should type username/password every time (never saved).
// Staff/CR/HOD logins get remembered after their first successful login,
// so the fields auto-fill next time and they just need to tap Login.
document.addEventListener("DOMContentLoaded", prefillLastLogin);

window.addEventListener("load", () => {
  const btn = $("installBtn");
  if (btn) {
    btn.addEventListener("click", async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      btn.classList.add("hidden");
    });
  }
  if ($("aDate")) $("aDate").value = getAttendanceDateStr();
});

function toast(msg){
  const t = $("toast");
  t.innerText = msg;
  t.style.display = "block";
  setTimeout(()=>t.style.display="none",2500);
}

async function login(){
  const role = $("loginRole").value;
  const username = $("loginUsername").value.trim();
  const password = $("loginPassword").value.trim();

  if(role === "admin"){
    if(username === "adminmasc" && password === "adminmasc@123"){
      currentUser = { role, username, department:"", year:"" };
      enterApp();
      return;
    }
    alert("Wrong username or password"); return;
  }

  try{
    const snap = await db.collection("users")
      .where("username","==",username)
      .where("password","==",password)
      .where("role","==",role)
      .limit(1).get();
    if(snap.empty){ alert("Wrong username or password"); return; }
    const u = snap.docs[0].data();
    currentUser = { role, username, department:u.department || "", year:u.year || "" };
    rememberLogin(role, username, password);
    enterApp();
  }catch(err){ alert("Login error: " + err.message); console.error(err); }
}

// Saves username/password for staff/CR/HOD only, so login auto-fills next time.
// Admin is never saved here (admin login returns early above, before this runs).
function rememberLogin(role, username, password){
  localStorage.setItem("lastLogin", JSON.stringify({role, username, password}));
}

// Auto-fills the last saved staff/CR/HOD login. Admin never gets here because
// rememberLogin() is never called for admin, so nothing is ever saved for it.
function prefillLastLogin(){
  const saved = localStorage.getItem("lastLogin");
  if(!saved) return;
  try{
    const {role, username, password} = JSON.parse(saved);
    if(role === "admin") return; // safety net, in case of old saved data
    if($("loginRole")) $("loginRole").value = role;
    if($("loginUsername")) $("loginUsername").value = username;
    if($("loginPassword")) $("loginPassword").value = password;
  }catch(e){ /* ignore corrupt data */ }
}

// Password See/Unsee toggle for the login page
function togglePasswordVisibility(){
  const pwd = $("loginPassword");
  const icon = $("togglePwdIcon");
  if(!pwd || !icon) return;
  if(pwd.type === "password"){
    pwd.type = "text";
    icon.innerText = "🙈";
  } else {
    pwd.type = "password";
    icon.innerText = "👁️";
  }
}

function enterApp(){
  $("loginPage").classList.add("hidden");
  $("appPage").classList.remove("hidden");
  $("currentUser").innerText = currentUser.role.toUpperCase() + " - " + currentUser.username +
    (currentUser.department ? ` (${currentUser.department}${currentUser.year ? ", "+currentUser.year : ""})` : "");
  applyRoleAccess();
  loadCurrentSemesterSetting();
  if(currentUser.role === "admin" || currentUser.role === "hod") checkAndRunPromotion();
  if(currentUser.role === "staff") initStaffNotifications();
}

async function loadCurrentSemesterSetting(){
  try{
    const doc = await db.collection("settings").doc("semester").get();
    currentSemesterCache = doc.exists ? (doc.data().value || "Odd") : "Odd";
    if($("aSemester")) $("aSemester").value = currentSemesterCache;
    if($("currentSemester")) $("currentSemester").value = currentSemesterCache;
  }catch(err){ console.error("loadCurrentSemesterSetting error:", err); }
  return currentSemesterCache;
}

async function saveCurrentSemester(){
  if(!currentUser || (currentUser.role !== "admin" && currentUser.role !== "hod")){
    alert("Idha admin/HOD mattum thaan use panna mudiyum"); return;
  }
  try{
    const value = $("currentSemester").value;
    await db.collection("settings").doc("semester").set({ value, updatedAt: new Date().toISOString() }, { merge:true });
    currentSemesterCache = value;
    if($("aSemester")) $("aSemester").value = value;
    toast(`Current Semester = ${value} ✅ (ella dept ku um andha semester subjects mattum ippa kaanum)`);
  }catch(err){ alert("Save semester error: " + err.message); console.error(err); }
}

function applyRoleAccess(){
  const role = currentUser.role;
  const access = {
    admin:  { navDashboard:1, navStudents:1, navAttendance:1, navReports:1, navNotifications:1, navTimetable:1, navAlumni:1, navSubjects:1, navLeave:1, navSettings:1, usersNavBtn:1, landing:"dashboard" },
    hod:    { navDashboard:1, navStudents:1, navAttendance:1, navReports:1, navNotifications:1, navTimetable:1, navAlumni:1, navSubjects:1, navLeave:1, navSettings:1, usersNavBtn:0, landing:"dashboard" },
    staff:  { navDashboard:0, navStudents:0, navAttendance:1, navReports:0, navNotifications:0, navTimetable:1, navAlumni:0, navSubjects:0, navLeave:1, navSettings:0, usersNavBtn:0, landing:"attendance" },
    cr:     { navDashboard:0, navStudents:1, navAttendance:0, navReports:0, navNotifications:0, navTimetable:0, navAlumni:0, navSubjects:0, navLeave:0, navSettings:0, usersNavBtn:0, landing:"students" }
  };
  const rules = access[role] || access.staff;
  ["navDashboard","navStudents","navAttendance","navReports","navNotifications","navTimetable","navAlumni","navSubjects","navLeave","navSettings","usersNavBtn"].forEach(id=>{
    $(id).classList.toggle("hidden", !rules[id]);
  });
  showPage(rules.landing);
}

function logout(){ location.reload(); }

function lockDeptYear(deptId, yearId){
  if($(deptId)) $(deptId).disabled = false;
  if($(yearId)) $(yearId).disabled = false;
}

function showPage(page){
  document.querySelectorAll(".page").forEach(p=>p.classList.add("hidden"));
  $(page).classList.remove("hidden");
  $("pageTitle").innerText = page.charAt(0).toUpperCase()+page.slice(1);
  if(page==="dashboard") loadDashboard();
  if(page==="students"){ lockDeptYear("filterDept","filterYear"); lockDeptYear("sDept","sYear"); loadStudents(); }
  if(page==="attendance"){ lockDeptYear("aDept","aYear"); if($("aSemester")) $("aSemester").value = currentSemesterCache; checkPeriodLocks(); }
  if(page==="reports") generateReport();
  if(page==="settings"){ firebaseCheck(); loadPromotionStatus(); loadCurrentSemesterSetting(); }
  if(page==="users") loadUsers();
  if(page==="timetable") loadMyTimetable();
  if(page==="alumni") loadAlumni();
  if(page==="subjects") loadSubjects();
  if(page==="leave") initLeavePage();
}

async function saveStudent(){
  try{
    const photoFile = $("sPhoto").files[0];
    let photoURL = "";
    const student = {
      name:$("sName").value.trim(), roll:$("sRoll").value.trim(), regNo:$("sReg").value.trim(),
      department:$("sDept").value, year:$("sYear").value, section:$("sSection").value.trim(),
      gender:$("sGender").value,
      phone:$("sPhone").value.trim(), parentPhone:$("sParentPhone").value.trim(),
      email:$("sEmail").value.trim(), address:$("sAddress").value.trim(),
      createdAt:new Date().toISOString(), week:getWeekKey(new Date()),
      month:new Date().toLocaleString("en-US",{month:"short",year:"numeric"})
    };
    if(!student.name || !student.roll || !student.department || !student.year || !student.parentPhone){
      alert("Name, Roll, Department, Year, Parent Phone required"); return;
    }
    if(photoFile){
      const ref = storage.ref("student_photos/" + Date.now() + "_" + photoFile.name);
      await ref.put(photoFile);
      photoURL = await ref.getDownloadURL();
    }
    student.photoURL = photoURL;
    await db.collection("students").add(student);
    toast("Student saved in Firebase ✅");
    document.querySelectorAll("#students input").forEach(i=>i.value="");
    $("sDept").value=""; $("sYear").value=""; $("sGender").value="";
    loadStudents();
  }catch(err){ alert("Firebase save error: " + err.message); console.error(err); }
}

async function loadStudents(){
  try{
    const snap = await db.collection("students").get();
    let students = snap.docs.map(d=>({id:d.id,...d.data()}));
    students.sort((a,b)=> naturalCompare(a.roll||"", b.roll||""));
    const dept = $("filterDept") ? $("filterDept").value : "";
    const year = $("filterYear") ? $("filterYear").value : "";
    const search = $("searchStudent") ? $("searchStudent").value.toLowerCase() : "";
    if(dept) students = students.filter(s=>s.department===dept);
    if(year) students = students.filter(s=>s.year===year);
    if(search) students = students.filter(s=>(s.name||"").toLowerCase().includes(search) || (s.roll||"").toLowerCase().includes(search));
    studentsData = students;
    const canEdit = currentUser && (currentUser.role === "admin" || currentUser.role === "hod");
    if($("editColHeader")) $("editColHeader").classList.toggle("hidden", !canEdit);
    $("studentTable").innerHTML = students.map(s=>`
      <tr>
        <td>${s.photoURL ? `<img class="avatar" src="${s.photoURL}"/>` : "👤"}</td>
        <td>${s.name}</td><td>${s.roll}</td><td>${s.department}</td><td>${s.year}</td><td>${s.parentPhone}</td>
        <td><button class="sms" onclick="sendSMS('${s.parentPhone}','${s.name}')">SMS</button>
        <button class="wa" onclick="sendWhatsApp('${s.parentPhone}','${s.name}')">WhatsApp</button></td>
        ${canEdit ? `<td><button onclick="editStudent('${s.id}')">Edit</button></td>` : ""}
      </tr>`).join("");
  }catch(err){ alert("Load students error: " + err.message); console.error(err); }
}

// Natural sort so roll numbers order correctly: 1,2,3...10 (not 1,10,2,3...)
// and works fine for prefixed rolls like "21CS002" too.
function naturalCompare(a, b){
  const re = /(\d+)|(\D+)/g;
  const ax = String(a).match(re) || [];
  const bx = String(b).match(re) || [];
  const len = Math.max(ax.length, bx.length);
  for(let i=0; i<len; i++){
    const av = ax[i] || "", bv = bx[i] || "";
    const an = parseInt(av,10), bn = parseInt(bv,10);
    if(!isNaN(an) && !isNaN(bn)){
      if(an !== bn) return an - bn;
    } else if(av !== bv){
      return av < bv ? -1 : 1;
    }
  }
  return 0;
}

let editingStudentId = null;

function editStudent(id){
  if(!currentUser || (currentUser.role !== "admin" && currentUser.role !== "hod")){
    alert("Idha admin/HOD mattum thaan use panna mudiyum"); return;
  }
  const s = studentsData.find(st=>st.id===id);
  if(!s){ alert("Student data kidaikala, list refresh pannunga"); return; }
  editingStudentId = id;
  $("eName").value = s.name || ""; $("eRoll").value = s.roll || ""; $("eReg").value = s.regNo || "";
  $("eDept").value = s.department || ""; $("eYear").value = s.year || ""; $("eGender").value = s.gender || "";
  $("eSection").value = s.section || ""; $("ePhone").value = s.phone || ""; $("eParentPhone").value = s.parentPhone || "";
  $("eEmail").value = s.email || ""; $("eAddress").value = s.address || ""; $("ePhoto").value = "";
  $("editStudentModal").classList.remove("hidden");
}

function closeEditStudentModal(){
  $("editStudentModal").classList.add("hidden");
  editingStudentId = null;
}

async function saveStudentEdit(){
  if(!editingStudentId) return;
  if(!currentUser || (currentUser.role !== "admin" && currentUser.role !== "hod")){
    alert("Idha admin/HOD mattum thaan use panna mudiyum"); return;
  }
  try{
    const updated = {
      name: $("eName").value.trim(), roll: $("eRoll").value.trim(), regNo: $("eReg").value.trim(),
      department: $("eDept").value, year: $("eYear").value, gender: $("eGender").value,
      section: $("eSection").value.trim(), phone: $("ePhone").value.trim(),
      parentPhone: $("eParentPhone").value.trim(), email: $("eEmail").value.trim(), address: $("eAddress").value.trim()
    };
    if(!updated.name || !updated.roll || !updated.department || !updated.year || !updated.parentPhone){
      alert("Name, Roll, Department, Year, Parent Phone required"); return;
    }
    const photoFile = $("ePhoto").files[0];
    if(photoFile){
      const ref = storage.ref("student_photos/" + Date.now() + "_" + photoFile.name);
      await ref.put(photoFile);
      updated.photoURL = await ref.getDownloadURL();
    }
    await db.collection("students").doc(editingStudentId).update(updated);
    toast("Student details updated ✅");
    closeEditStudentModal();
    loadStudents();
  }catch(err){ alert("Update error: " + err.message); console.error(err); }
}

function getSelectedPeriods(){
  return [...document.querySelectorAll("#periodChecks input:checked")].map(c=>c.value);
}

// Disables (locks) any period that's already been marked today for the
// current Date + Department + Year + Subject combo, so staff can't
// accidentally press it twice. It naturally "resets fresh" every day
// because the Attendance Day (6 AM cutoff) changes, so no old lock matches.
async function checkPeriodLocks(){
  const date = $("aDate").value, department = $("aDept").value, year = $("aYear").value, subject = $("aSubject").value.trim();
  const checkboxes = [...document.querySelectorAll("#periodChecks input")];
  if(!date || !department || !year || !subject){
    checkboxes.forEach(c=>{ c.disabled = false; const label = c.closest("label"); if(label) label.classList.remove("locked"); });
    return;
  }
  try{
    const snap = await db.collection("attendance")
      .where("date","==",date).where("department","==",department)
      .where("year","==",year).where("subject","==",subject).get();
    const lockedPeriods = new Set(snap.docs.map(d=>d.data().period));
    checkboxes.forEach(c=>{
      const label = c.closest("label");
      const span = label ? label.querySelector("span") : null;
      const baseText = "Period " + c.value.replace("Period ","");
      const isLocked = lockedPeriods.has(c.value);
      c.disabled = isLocked;
      if(isLocked) c.checked = false;
      if(label) label.classList.toggle("locked", isLocked);
      if(span) span.innerText = isLocked ? baseText + " ✅ Marked" : baseText;
    });
  }catch(err){ console.error("checkPeriodLocks error:", err); }
}

async function loadAttendanceStudents(){
  await loadStudents();
  await checkPeriodLocks();
  const dept = $("aDept").value, year = $("aYear").value, subject = $("aSubject").value.trim();
  const periods = getSelectedPeriods();
  const list = studentsData.filter(s=>s.department===dept && s.year===year);
  if(!$("aDate").value) $("aDate").value = getAttendanceDateStr();
  if(!dept || !year || !subject){ alert("Date, Subject, Department, Year required"); return; }
  if(periods.length===0){ alert("Select at least one Period (1 to 5) — already-marked periods are locked, oru puthu period select pannunga"); return; }
  if(list.length===0){ $("attendanceList").innerHTML = "<p>No students found.</p>"; return; }
  $("attendanceList").innerHTML = list.map(s=>`
    <div class="row-card"><span><b>${s.name}</b> (${s.roll})</span>
    <select data-id="${s.id}" data-name="${s.name}" data-roll="${s.roll}">
      <option value="Present">Present</option><option value="Absent">Absent</option>
    </select></div>`).join("");
}

async function saveAttendance(){
  try{
    const date = $("aDate").value, subject = $("aSubject").value.trim(), department = $("aDept").value, year = $("aYear").value;
    let periods = getSelectedPeriods();
    const rows = [...document.querySelectorAll("#attendanceList select")];
    if(!date || !subject || !department || !year || rows.length===0){ alert("Load students first"); return; }
    if(periods.length===0){ alert("Select at least one Period (1 to 5)"); return; }

    // Final re-check right before writing, so two staff can't double-mark the same period
    const lockSnap = await db.collection("attendance")
      .where("date","==",date).where("department","==",department)
      .where("year","==",year).where("subject","==",subject).get();
    const alreadyMarked = new Set(lockSnap.docs.map(d=>d.data().period));
    const blockedNow = periods.filter(p=>alreadyMarked.has(p));
    periods = periods.filter(p=>!alreadyMarked.has(p));
    if(blockedNow.length > 0){
      alert(`${blockedNow.join(", ")} ku already attendance potachu — adha thavirthu, meethi periods save pannuren.`);
    }
    if(periods.length === 0){ toast("Ella selected periods um already marked ah irukku"); checkPeriodLocks(); return; }

    for(const r of rows){
      for(const period of periods){
        await db.collection("attendance").add({
          studentId:r.dataset.id, name:r.dataset.name, roll:r.dataset.roll, status:r.value,
          date, subject, department, year, period, markedBy: currentUser ? currentUser.username : "admin",
          createdAt:new Date().toISOString(), week:getWeekKey(new Date(date)),
          month:new Date(date).toLocaleString("en-US",{month:"short",year:"numeric"})
        });
      }
    }
    toast(`Attendance saved for ${periods.length} period(s) ✅`);
    $("attendanceList").innerHTML="";
    document.querySelectorAll("#periodChecks input").forEach(c=>c.checked=false);
    checkPeriodLocks(); // immediately grey out the just-saved periods
    loadDashboard();
  }catch(err){ alert("Attendance save error: " + err.message); console.error(err); }
}

async function loadDashboard(){
  const sSnap = await db.collection("students").get();
  const aSnap = await db.collection("attendance").get();
  const students = sSnap.docs.map(d=>({id:d.id, ...d.data()}));
  const studentById = {}; students.forEach(s=> studentById[s.id] = s);
  const attendance = aSnap.docs.map(d=>d.data());

  const todayStr = getAttendanceDateStr(); // resets fresh at 6 AM daily, timezone-safe
  const todayAttendance = attendance.filter(a=>a.date === todayStr);

  $("totalStudents").innerText = students.length;
  // Each attendance record = 1 period = 1 hour, so count of records = total hours today
  const todayPresentHrs = todayAttendance.filter(a=>a.status==="Present").length;
  const todayAbsentHrs = todayAttendance.filter(a=>a.status==="Absent").length;
  $("totalPresent").innerText = todayPresentHrs;
  $("totalAbsent").innerText = todayAbsentHrs;
  const todayAvg = todayAttendance.length ? Math.round((todayPresentHrs/todayAttendance.length)*100) : 0;
  $("avgPercent").innerText = todayAvg + "%";

  renderDashboardChart(attendance, students);
  renderGenderCharts(todayAttendance, studentById);
  renderDepartmentChart(todayAttendance, students);
}

const DEPT_COLORS = {
  "Computer Science":"#6366f1", "BCA":"#f59e0b", "B.Com":"#10b981", "BBA":"#ef4444",
  "Mathematics":"#3b82f6", "English":"#ec4899", "Bio Tech":"#14b8a6", "M.com":"#a855f7",
  "Hoteal Management":"#f97316"
};

function renderGenderCharts(todayAttendance, studentById){
  const boys = { Present:0, Absent:0 }, girls = { Present:0, Absent:0 };
  todayAttendance.forEach(a=>{
    const s = studentById[a.studentId];
    if(!s || !s.gender) return;
    if(s.gender === "Male" && boys[a.status] !== undefined) boys[a.status]++;
    else if(s.gender === "Female" && girls[a.status] !== undefined) girls[a.status]++;
  });
  if(boysChart) boysChart.destroy();
  boysChart = new Chart($("boysChart"), {
    type:"doughnut",
    data:{ labels:["Present (Hrs)","Absent (Hrs)"], datasets:[{ data:[boys.Present, boys.Absent], backgroundColor:["#22c55e","#ef4444"] }] },
    options:{ responsive:true }
  });
  if(girlsChart) girlsChart.destroy();
  girlsChart = new Chart($("girlsChart"), {
    type:"doughnut",
    data:{ labels:["Present (Hrs)","Absent (Hrs)"], datasets:[{ data:[girls.Present, girls.Absent], backgroundColor:["#22c55e","#ef4444"] }] },
    options:{ responsive:true }
  });
}

function renderDepartmentChart(todayAttendance, students){
  const depts = [...new Set(students.map(s=>s.department).filter(Boolean))];
  const presentCounts = depts.map(d=> todayAttendance.filter(a=>a.department===d && a.status==="Present").length);
  const colors = depts.map(d=> DEPT_COLORS[d] || "#94a3b8");
  if(deptChart) deptChart.destroy();
  deptChart = new Chart($("departmentChart"), {
    type:"bar",
    data:{ labels:depts, datasets:[{ label:"Today Present (Hrs)", data:presentCounts, backgroundColor:colors }] },
    options:{ responsive:true, plugins:{ legend:{ display:false } }, scales:{ y:{ beginAtZero:true, ticks:{ precision:0 } } } }
  });
}

async function generateReport(){
  const sSnap = await db.collection("students").get();
  const aSnap = await db.collection("attendance").get();
  let students = sSnap.docs.map(d=>({id:d.id,...d.data()}));
  const attendance = aSnap.docs.map(d=>d.data());
  const dept = $("rDept").value, year = $("rYear").value, subject = $("rSubject").value.toLowerCase();
  const period = $("rPeriod") ? $("rPeriod").value : "";
  if(dept) students = students.filter(s=>s.department===dept);
  if(year) students = students.filter(s=>s.year===year);
  reportRows = students.map(s=>{
    let rec = attendance.filter(a=>a.studentId===s.id);
    if(subject) rec = rec.filter(a=>(a.subject||"").toLowerCase().includes(subject));
    if(period) rec = rec.filter(a=>a.period===period);
    const present = rec.filter(a=>a.status==="Present").length;
    const absent = rec.filter(a=>a.status==="Absent").length;
    const total = rec.length;
    const percentage = total ? Math.round((present/total)*100) : 0;
    return {name:s.name, roll:s.roll, present, absent, total, percentage:percentage+"%"};
  });
  $("reportTable").innerHTML = reportRows.map(r=>`
    <tr><td>${r.name}</td><td>${r.roll}</td><td>${r.present}</td><td>${r.absent}</td><td>${r.total}</td><td>${r.percentage}</td></tr>`).join("");
}

function downloadCSV(){
  if(!reportRows.length){ alert("Generate report first"); return; }
  const header = "Name,Roll,Present,Absent,Total,Percentage\n";
  const body = reportRows.map(r=>`${r.name},${r.roll},${r.present},${r.absent},${r.total},${r.percentage}`).join("\n");
  const blob = new Blob([header+body], {type:"text/csv"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "attendance-report.csv"; a.click();
}

function sendSMS(phone, name){
  const msg = encodeURIComponent(`Dear Parent, ${name} attendance/student details updated in Madha Attendance App.`);
  window.location.href = `sms:${phone}?body=${msg}`;
}
function sendWhatsApp(phone, name){
  const msg = encodeURIComponent(`Dear Parent, ${name} attendance/student details updated in Madha Attendance App.`);
  window.open(`https://wa.me/${phone}?text=${msg}`, "_blank");
}

async function firebaseCheck(){
  const sSnap = await db.collection("students").limit(20).get();
  const aSnap = await db.collection("attendance").limit(20).get();
  const data = {students:sSnap.docs.map(d=>({id:d.id,...d.data()})), attendance:aSnap.docs.map(d=>({id:d.id,...d.data()}))};
  $("firebaseOutput").innerText = JSON.stringify(data, null, 2);
}

async function saveUser(){
  try{
    const role = $("uRole").value, username = $("uUsername").value.trim(), password = $("uPassword").value.trim();
    const department = $("uDept").value, year = $("uYear").value;
    if(!username || !password || !department){ alert("Username, Password, Department required"); return; }
    const existing = await db.collection("users").where("username","==",username).limit(1).get();
    if(!existing.empty){ alert("Username already exists"); return; }
    await db.collection("users").add({ role, username, password, department, year, createdAt:new Date().toISOString() });
    toast("Login created ✅");
    $("uUsername").value=""; $("uPassword").value=""; $("uDept").value=""; $("uYear").value="";
    loadUsers();
  }catch(err){ alert("Create login error: " + err.message); console.error(err); }
}

async function loadUsers(){
  try{
    const snap = await db.collection("users").orderBy("createdAt","desc").get();
    const users = snap.docs.map(d=>({id:d.id,...d.data()}));
    $("userTable").innerHTML = users.map(u=>`
      <tr><td>${u.username}</td><td>${u.role.toUpperCase()}</td><td>${u.department}</td><td>${u.year||"All"}</td>
      <td><button onclick="deleteUser('${u.id}')">Delete</button></td></tr>`).join("");
  }catch(err){ alert("Load logins error: " + err.message); console.error(err); }
}

async function deleteUser(id){
  if(!confirm("Delete this login?")) return;
  await db.collection("users").doc(id).delete();
  toast("Login deleted");
  loadUsers();
}

function getWeekKey(date){
  const first = new Date(date.getFullYear(),0,1);
  const days = Math.floor((date - first)/(24*60*60*1000));
  return "Week " + Math.ceil((days + first.getDay() + 1)/7);
}

// ==========================================================
// YEAR PROMOTION (I Year -> II Year -> III Year -> Passed Out)
// Runs automatically once every year on/after June 1st.
// ==========================================================
const NEXT_YEAR_MAP = { "I Year":"II Year", "II Year":"III Year" };

async function loadPromotionStatus(){
  try{
    const doc = await db.collection("settings").doc("academic").get();
    const data = doc.exists ? doc.data() : {};
    $("lastPromotionYear").innerText = data.lastPromotionYear
      ? `${data.lastPromotionYear} (${new Date(data.lastRunAt).toLocaleDateString()})`
      : "Never run yet";
  }catch(err){ console.error("loadPromotionStatus error:", err); }
}

async function checkAndRunPromotion(){
  try{
    const today = new Date();
    const promotionDate = new Date(today.getFullYear(), 5, 1); // June 1
    const doc = await db.collection("settings").doc("academic").get();
    const lastYear = doc.exists ? (doc.data().lastPromotionYear || 0) : 0;
    if(today >= promotionDate && lastYear < today.getFullYear()){
      const ok = confirm(`New academic year detected (June 1, ${today.getFullYear()}).\nPromote all students now?\nI Year -> II Year, II Year -> III Year, III Year -> Passed Out (Alumni).`);
      if(ok) await promoteAllStudents(today.getFullYear());
    }
  }catch(err){ console.error("checkAndRunPromotion error:", err); }
}

async function runPromotionNow(){
  const yearNum = new Date().getFullYear();
  if(!confirm(`Run promotion now?\nI Year -> II Year, II Year -> III Year, III Year -> Passed Out (Alumni).`)) return;
  await promoteAllStudents(yearNum);
}

async function promoteAllStudents(yearNum){
  try{
    toast("Promotion running… please wait");
    const snap = await db.collection("students").get();
    const students = snap.docs.map(d=>({id:d.id, ...d.data()}));
    let batch = db.batch();
    let opCount = 0, promoted = 0, passedOut = 0;
    for(const s of students){
      if(NEXT_YEAR_MAP[s.year]){
        batch.update(db.collection("students").doc(s.id), { year: NEXT_YEAR_MAP[s.year] });
        opCount++; promoted++;
      } else if(s.year === "III Year"){
        const { id, ...rest } = s;
        batch.set(db.collection("passedOut").doc(id), { ...rest, passOutYear: yearNum, promotedAt: new Date().toISOString() });
        batch.delete(db.collection("students").doc(id));
        opCount += 2; passedOut++;
      }
      if(opCount >= 400){ await batch.commit(); batch = db.batch(); opCount = 0; }
    }
    if(opCount > 0) await batch.commit();
    await db.collection("settings").doc("academic").set({ lastPromotionYear: yearNum, lastRunAt: new Date().toISOString() }, { merge:true });
    toast(`Promotion done ✅ ${promoted} promoted, ${passedOut} passed out`);
    loadPromotionStatus();
    if($("students") && !$("students").classList.contains("hidden")) loadStudents();
  }catch(err){ alert("Promotion error: " + err.message); console.error(err); }
}

// ==========================================================
// ALUMNI (Passed Out students archive)
// ==========================================================
async function loadAlumni(){
  try{
    const snap = await db.collection("passedOut").orderBy("promotedAt","desc").get();
    let alumni = snap.docs.map(d=>({id:d.id,...d.data()}));
    const dept = $("alumniDept") ? $("alumniDept").value : "";
    const search = $("alumniSearch") ? $("alumniSearch").value.toLowerCase() : "";
    if(dept) alumni = alumni.filter(a=>a.department===dept);
    if(search) alumni = alumni.filter(a=>(a.name||"").toLowerCase().includes(search) || (a.roll||"").toLowerCase().includes(search));
    $("alumniTable").innerHTML = alumni.map(a=>`
      <tr><td>${a.name}</td><td>${a.roll}</td><td>${a.department}</td><td>${a.passOutYear||""}</td><td>${a.parentPhone||""}</td></tr>`).join("");
  }catch(err){ alert("Load alumni error: " + err.message); console.error(err); }
}

// ==========================================================
// SUBJECT MASTER (admin/hod manage; attendance page reads it)
// ==========================================================
async function saveSubject(){
  if(!currentUser || (currentUser.role !== "admin" && currentUser.role !== "hod")){
    alert("Idha admin/HOD mattum thaan use panna mudiyum"); return;
  }
  try{
    const department = $("subDept").value, year = $("subYear").value, name = $("subName").value.trim();
    const isSpecial = $("subSpecial").checked;
    const semester = isSpecial ? "Both" : $("subSemester").value;
    if(!name){ alert("Subject name podunga"); return; }
    await db.collection("subjects").add({ department, year, semester, name, isSpecial, createdAt:new Date().toISOString() });
    toast("Subject added ✅");
    $("subName").value=""; $("subSpecial").checked = false;
    loadSubjects();
  }catch(err){ alert("Save subject error: " + err.message); console.error(err); }
}

async function loadSubjects(){
  try{
    let snap = await db.collection("subjects").get();
    if(snap.empty){
      // First-time convenience seed so PT/Library are always available
      await db.collection("subjects").add({ department:"All Departments", year:"All Years", semester:"Both", name:"PT Period", isSpecial:true, createdAt:new Date().toISOString() });
      await db.collection("subjects").add({ department:"All Departments", year:"All Years", semester:"Both", name:"Library Hour", isSpecial:true, createdAt:new Date().toISOString() });
      snap = await db.collection("subjects").get();
    }
    const subjects = snap.docs.map(d=>({id:d.id, ...d.data()}));
    const canManage = currentUser && (currentUser.role === "admin" || currentUser.role === "hod");
    $("subjectTable").innerHTML = subjects.map(s=>`
      <tr><td>${s.name}</td><td>${s.department}</td><td>${s.year}</td><td>${s.semester||"Both"}</td><td>${s.isSpecial ? "Special" : "Regular"}</td>
      <td>${canManage ? `<button onclick="deleteSubject('${s.id}')">Delete</button>` : ""}</td></tr>`).join("");
  }catch(err){ alert("Load subjects error: " + err.message); console.error(err); }
}

async function deleteSubject(id){
  if(!currentUser || (currentUser.role !== "admin" && currentUser.role !== "hod")){
    alert("Idha admin/HOD mattum thaan use panna mudiyum"); return;
  }
  if(!confirm("Delete this subject?")) return;
  await db.collection("subjects").doc(id).delete();
  toast("Subject deleted");
  loadSubjects();
}

// Populates the Attendance page's Subject dropdown based on chosen Dept + Year + Semester
async function loadSubjectOptions(){
  const dept = $("aDept").value, year = $("aYear").value, semester = $("aSemester") ? $("aSemester").value : "Odd";
  const sel = $("aSubject");
  if(!dept || !year){ sel.innerHTML = `<option value="">Select Subject</option>`; return; }
  try{
    const snap = await db.collection("subjects").get();
    const subjects = snap.docs.map(d=>d.data()).filter(s=>
      (s.department === dept || s.department === "All Departments") &&
      (s.year === year || s.year === "All Years") &&
      (s.isSpecial || (s.semester || "Odd") === semester || s.semester === "Both")
    );
    subjects.sort((a,b)=> (a.isSpecial === b.isSpecial) ? a.name.localeCompare(b.name) : (a.isSpecial ? 1 : -1));
    sel.innerHTML = `<option value="">Select Subject</option>` +
      subjects.map(s=> `<option>${s.isSpecial ? "🔁 " : ""}${s.name}</option>`).join("");
  }catch(err){ console.error("loadSubjectOptions error:", err); }
}

// ==========================================================
// STAFF LEAVE APPLICATION
// Leave can only be submitted once every period on that day
// has a substitute staff assigned — unless it's an Exam Day.
// ==========================================================
let leaveTimetableForDate = []; // today's [{id, period, department, year, subject, startTime}]

async function initLeavePage(){
  $("allLeaveCard").classList.toggle("hidden", !(currentUser && (currentUser.role === "admin" || currentUser.role === "hod")));
  if(!$("leaveDate").value) $("leaveDate").value = getAttendanceDateStr();
  await loadLeavePeriodsForDate();
  await loadMyLeaveRequests();
  if(currentUser && (currentUser.role === "admin" || currentUser.role === "hod")) await loadAllLeaveRequests();
}

async function loadLeavePeriodsForDate(){
  const date = $("leaveDate").value;
  const isExamDay = $("leaveExamDay").checked;
  leaveTimetableForDate = [];
  if(!date){ $("leavePeriodsList").innerHTML = ""; return; }
  if(isExamDay){
    $("leavePeriodsList").innerHTML = `<p>Exam Day nu select pannirukinga — substitute select panna thevai illa.</p>`;
    return;
  }
  try{
    const dow = new Date(date + "T12:00:00").getDay(); // noon avoids any TZ date-shift
    const snap = await db.collection("timetable")
      .where("staffUsername","==",currentUser.username)
      .where("dayOfWeek","==",dow).get();
    leaveTimetableForDate = snap.docs.map(d=>({ id:d.id, ...d.data() }))
      .sort((a,b)=> a.startTime.localeCompare(b.startTime));

    if(leaveTimetableForDate.length === 0){
      $("leavePeriodsList").innerHTML = `<p>Andha naaliku unga timetable-la class edhuvum illa — neenga free ah leave apply pannalam.</p>`;
      return;
    }
    const staffSnap = await db.collection("users").where("role","==","staff").get();
    const otherStaff = staffSnap.docs.map(d=>d.data()).filter(u=>u.username !== currentUser.username);

    $("leavePeriodsList").innerHTML = leaveTimetableForDate.map(t=>`
      <div class="legend-row" style="flex-direction:column;align-items:flex-start">
        <b>${t.period} - ${t.subject} (${t.year} ${t.department}${t.section? " "+t.section:""})</b>
        <select id="sub_${t.id}" onchange="toggleOtherSubField('${t.id}')">
          <option value="">-- Substitute Staff select pannunga --</option>
          ${otherStaff.map(u=>`<option value="${u.username}">${u.username}</option>`).join("")}
          <option value="__other__">Others (name type pannunga)</option>
        </select>
        <input id="subOther_${t.id}" class="hidden" placeholder="Substitute person name"/>
      </div>`).join("");
  }catch(err){ alert("Load timetable for leave error: " + err.message); console.error(err); }
}

function toggleOtherSubField(timetableId){
  const sel = $("sub_" + timetableId);
  const otherInput = $("subOther_" + timetableId);
  if(!sel || !otherInput) return;
  otherInput.classList.toggle("hidden", sel.value !== "__other__");
  if(sel.value === "__other__") otherInput.focus();
}

async function submitLeaveRequest(){
  try{
    const date = $("leaveDate").value, reason = $("leaveReason").value.trim(), isExamDay = $("leaveExamDay").checked;
    if(!date){ alert("Date select pannunga"); return; }
    if(!reason){ alert("Reason podunga"); return; }

    const coverage = [];
    if(!isExamDay && leaveTimetableForDate.length > 0){
      for(const t of leaveTimetableForDate){
        const sub = $("sub_" + t.id);
        const subValue = sub ? sub.value : "";
        let substituteStaffUsername = "", substituteName = "";
        if(subValue === "__other__"){
          const otherInput = $("subOther_" + t.id);
          substituteName = otherInput ? otherInput.value.trim() : "";
          if(!substituteName){
            alert(`"${t.period} - ${t.subject}" ku substitute person peru type pannunga.`);
            return;
          }
        } else if(subValue){
          substituteStaffUsername = subValue;
          substituteName = subValue;
        } else {
          alert(`"${t.period} - ${t.subject}" ku substitute select pannama leave apply panna mudiyathu. (Exam day na "Exam Day" checkbox tick pannunga)`);
          return;
        }
        coverage.push({ timetableId:t.id, period:t.period, department:t.department, year:t.year, section:t.section||"", subject:t.subject, substituteStaffUsername, substituteName });
      }
    }

    await db.collection("leaveRequests").add({
      staffUsername: currentUser.username, date, reason, isExamDay, coverage,
      createdAt: new Date().toISOString()
    });
    toast("Leave request saved ✅" + (coverage.length ? " (substitutes notified)" : ""));
    $("leaveReason").value = "";
    await loadMyLeaveRequests();
    if(currentUser.role === "admin" || currentUser.role === "hod") await loadAllLeaveRequests();
  }catch(err){ alert("Leave submit error: " + err.message); console.error(err); }
}

async function loadMyLeaveRequests(){
  try{
    const snap = await db.collection("leaveRequests").where("staffUsername","==",currentUser.username).get();
    const requests = snap.docs.map(d=>d.data()).sort((a,b)=> b.date.localeCompare(a.date));
    $("myLeaveTable").innerHTML = requests.map(r=>`
      <tr><td>${r.date}</td><td>${r.reason}</td><td>${r.isExamDay ? "Yes" : "No"}</td>
      <td>${(r.coverage||[]).map(c=>`${c.period}→${c.substituteName||c.substituteStaffUsername}`).join(", ") || "-"}</td></tr>`).join("");
  }catch(err){ console.error("loadMyLeaveRequests error:", err); }
}

async function loadAllLeaveRequests(){
  try{
    const snap = await db.collection("leaveRequests").get();
    const requests = snap.docs.map(d=>d.data()).sort((a,b)=> b.date.localeCompare(a.date));
    $("allLeaveTable").innerHTML = requests.map(r=>`
      <tr><td>${r.staffUsername}</td><td>${r.date}</td><td>${r.reason}</td><td>${r.isExamDay ? "Yes" : "No"}</td>
      <td>${(r.coverage||[]).map(c=>`${c.period}→${c.substituteName||c.substituteStaffUsername}`).join(", ") || "-"}</td></tr>`).join("");
  }catch(err){ console.error("loadAllLeaveRequests error:", err); }
}

// ==========================================================
// STAFF TIMETABLE (Firebase Firestore, collection "timetable")
// ==========================================================
const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const PERIOD_TIMES = {
  "Period 1": ["09:00","10:00"], "Period 2": ["10:00","11:00"], "Period 3": ["11:00","12:00"],
  "Period 4": ["12:00","13:00"], "Period 5": ["13:00","14:00"]
};

async function saveTimetableEntry(){
  try{
    const period = $("ttPeriod").value;
    const [startTime, endTime] = PERIOD_TIMES[period];
    const entry = {
      staffUsername: currentUser.username, staffName: currentUser.username,
      dayOfWeek: parseInt($("ttDay").value), period, startTime, endTime,
      department: $("ttDept").value, year: $("ttYear").value,
      section: $("ttSection").value.trim(), subject: $("ttSubject").value.trim(),
      createdAt: new Date().toISOString()
    };
    if(!entry.department || !entry.year || !entry.subject){ alert("Department, Year, Subject required"); return; }
    await db.collection("timetable").add(entry);
    toast("Timetable entry saved ✅");
    $("ttSection").value=""; $("ttSubject").value="";
    loadMyTimetable();
    if(currentUser.role === "staff") initStaffNotifications();
  }catch(err){ alert("Timetable save error: " + err.message); console.error(err); }
}

async function loadMyTimetable(){
  try{
    const snap = await db.collection("timetable").where("staffUsername","==",currentUser.username).get();
    const data = snap.docs.map(d=>({id:d.id, ...d.data()}))
      .sort((a,b)=> a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime));
    $("timetableTable").innerHTML = data.map(t=>`
      <tr><td>${DAY_NAMES[t.dayOfWeek]}</td><td>${t.period}</td><td>${t.department}</td><td>${t.year}</td><td>${t.section||"-"}</td><td>${t.subject}</td>
      <td><button onclick="deleteTimetableEntry('${t.id}')">Delete</button></td></tr>`).join("");
  }catch(err){ alert("Load timetable error: " + err.message); console.error(err); }
}

async function deleteTimetableEntry(id){
  if(!confirm("Delete this timetable entry?")) return;
  await db.collection("timetable").doc(id).delete();
  toast("Deleted");
  loadMyTimetable();
  if(currentUser.role === "staff") initStaffNotifications();
}

// ==========================================================
// PDF TIMETABLE UPLOAD — parse grid, then staff reviews &
// maps class-codes (e.g. "IICS(LAB)") to Department/Year
// before anything is saved to Firestore.
// ==========================================================
const DAY_ORDER_LABELS = ["I","II","III","IV","V","VI"];
const DEFAULT_WEEKDAY_FOR_DAYORDER = { "I":1, "II":2, "III":3, "IV":4, "V":5, "VI":6 }; // Mon..Sat
let pdfParsedGrid = null;      // [{dayLabel, cells:[periodTexts...]}]
let pdfCodeLegendDraft = {};   // code -> {department, year, isLab, subject}
let pdfDayWeekdayDraft = {};   // dayLabel -> weekday number

async function handleTimetablePdfUpload(){
  try{
    const file = $("ttPdfFile").files[0];
    if(!file){ alert("PDF file select pannunga"); return; }
    if(typeof pdfjsLib === "undefined"){ alert("PDF library load aaga la. Internet check panni page reload pannunga."); return; }
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    toast("PDF padikkurom...");
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let items = [];
    for(let p=1; p<=pdf.numPages; p++){
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      content.items.forEach(it=>{
        if(it.str.trim()) items.push({ text: it.str.trim(), x: it.transform[4], y: it.transform[5] });
      });
    }
    if(items.length === 0){
      alert("PDF la text edukka mudiyala. Idhu scanned photo/image PDF ah irukalam — Excel/Word la irundhu 'Export/Save as PDF' panni try pannunga.");
      return;
    }
    const grid = buildGridFromItems(items);
    if(!grid || grid.length === 0){
      alert("Timetable grid clear ah detect panna mudiyala. Format vera ma maadhiri irukalam. Manual ah 'Add to Timetable' form use pannunga, illa vera PDF try pannunga.");
      return;
    }
    await showPdfPreview(grid);
  }catch(err){ alert("PDF parse error: " + err.message); console.error(err); }
}

function buildGridFromItems(items){
  // 1. Cluster text items into visual rows using Y position (PDF y grows upward)
  const rows = [];
  items.slice().sort((a,b)=> b.y - a.y).forEach(it=>{
    let row = rows.find(r=> Math.abs(r.y - it.y) <= 4);
    if(!row){ row = { y: it.y, items: [] }; rows.push(row); }
    row.items.push(it);
  });
  rows.forEach(r=> r.items.sort((a,b)=> a.x - b.x));

  // 2. Find the header row: must contain "HOUR" and several Roman-numeral column headers
  const headerRowIdx = rows.findIndex(r=>{
    const txt = r.items.map(i=>i.text).join(" ").toUpperCase();
    return txt.includes("HOUR");
  });
  if(headerRowIdx === -1) return null;
  const headerRow = rows[headerRowIdx];
  const periodHeaders = headerRow.items.filter(i=> /^(I|II|III|IV|V)$/i.test(i.text));
  if(periodHeaders.length < 3) return null;
  const colAnchors = periodHeaders.map(h=>h.x);

  // 3. Data rows after the header: first cell = Day Order label (I..VI), rest = period cell text
  const grid = [];
  rows.slice(headerRowIdx+1).forEach(r=>{
    if(r.items.length === 0) return;
    const first = r.items[0];
    if(!/^(I|II|III|IV|V|VI)$/i.test(first.text)) return; // skip title/footer noise rows
    const dayLabel = first.text.toUpperCase();
    const cells = colAnchors.map(()=> "");
    r.items.slice(1).forEach(it=>{
      let bestIdx = 0, bestDist = Infinity;
      colAnchors.forEach((ax,idx)=>{
        const d = Math.abs(ax - it.x);
        if(d < bestDist){ bestDist = d; bestIdx = idx; }
      });
      cells[bestIdx] = (cells[bestIdx] ? cells[bestIdx] + " " : "") + it.text;
    });
    grid.push({ dayLabel, cells });
  });
  return grid;
}

async function showPdfPreview(grid){
  pdfParsedGrid = grid;
  pdfDayWeekdayDraft = {};
  grid.forEach(r=>{ pdfDayWeekdayDraft[r.dayLabel] = DEFAULT_WEEKDAY_FOR_DAYORDER[r.dayLabel] ?? 1; });
  renderPdfGridInputs(grid);
  renderPdfDayOrderForm(grid);
  $("pdfPreviewSection").classList.remove("hidden");
  await rescanPdfCodes();
}

function renderPdfGridInputs(grid){
  $("pdfGridPreview").innerHTML = `
    <table><thead><tr><th>Day Order</th>${[1,2,3,4,5].map(p=>`<th>Period ${p}</th>`).join("")}</tr></thead>
    <tbody>
    ${grid.map((r,ri)=>`<tr><td><b>${r.dayLabel}</b></td>${[0,1,2,3,4].map(ci=>`
      <td><input id="gridCell_${ri}_${ci}" value="${escapeAttr(r.cells[ci]||"")}"/></td>`).join("")}</tr>`).join("")}
    </tbody></table>`;
}

function readGridFromInputs(){
  pdfParsedGrid.forEach((r,ri)=>{
    r.cells = r.cells.map((c,ci)=>{
      const el = document.getElementById(`gridCell_${ri}_${ci}`);
      return el ? el.value.trim() : c;
    });
  });
}

async function rescanPdfCodes(){
  readGridFromInputs();
  const codesSet = new Set();
  pdfParsedGrid.forEach(r=> r.cells.forEach(c=>{ if(c && c.trim()) codesSet.add(c.trim()); }));
  const codes = [...codesSet];

  let existingLegend = {};
  try{
    const snap = await db.collection("classCodeLegend").get();
    snap.docs.forEach(d=>{ existingLegend[d.id] = d.data(); });
  }catch(e){ console.error(e); }

  const prevDraft = pdfCodeLegendDraft;
  pdfCodeLegendDraft = {};
  codes.forEach(code=>{
    if(prevDraft[code]){ pdfCodeLegendDraft[code] = prevDraft[code]; return; } // keep edits already made
    const key = code.toUpperCase();
    const existing = existingLegend[key];
    const guessedLab = /\(LAB\)/i.test(code);
    const guessedYear = (code.match(/^(III|II|I)/i) || [,""])[1].toUpperCase();
    const yearMap = { "I":"I Year", "II":"II Year", "III":"III Year" };
    pdfCodeLegendDraft[code] = existing || { department:"", year: yearMap[guessedYear] || "", isLab: guessedLab, subject: code };
  });

  renderPdfLegendForm(codes);
  toast(`${codes.length} unique class-code(s) found`);
}

function renderPdfLegendForm(codes){
  const deptOptions = ["Computer Science","BCA","B.Com","BBA","Mathematics","English","Bio Tech","M.com","Hoteal Management"];
  const yearOptions = ["I Year","II Year","III Year"];
  $("pdfLegendForm").innerHTML = codes.map(code=>{
    const leg = pdfCodeLegendDraft[code];
    return `
    <div class="legend-row">
      <b>${code}</b>
      <select onchange="updateLegendDraft('${escapeAttr(code)}','department',this.value)">
        <option value="">Dept?</option>
        ${deptOptions.map(d=>`<option ${leg.department===d?"selected":""}>${d}</option>`).join("")}
      </select>
      <select onchange="updateLegendDraft('${escapeAttr(code)}','year',this.value)">
        <option value="">Year?</option>
        ${yearOptions.map(y=>`<option ${leg.year===y?"selected":""}>${y}</option>`).join("")}
      </select>
      <input value="${escapeAttr(leg.subject||code)}" placeholder="Subject label" onchange="updateLegendDraft('${escapeAttr(code)}','subject',this.value)"/>
      <label><input type="checkbox" ${leg.isLab?"checked":""} onchange="updateLegendDraft('${escapeAttr(code)}','isLab',this.checked)"/> Lab</label>
    </div>`;
  }).join("");
}

function renderPdfDayOrderForm(grid){
  const weekdays = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  $("pdfDayOrderForm").innerHTML = grid.map(r=>`
    <div class="legend-row">
      <b>Day Order ${r.dayLabel}</b> =
      <select onchange="pdfDayWeekdayDraft['${r.dayLabel}']=parseInt(this.value)">
        ${weekdays.map((w,i)=>`<option value="${i}" ${pdfDayWeekdayDraft[r.dayLabel]===i?"selected":""}>${w}</option>`).join("")}
      </select>
    </div>`).join("");
}

function updateLegendDraft(code, field, value){
  if(!pdfCodeLegendDraft[code]) return;
  pdfCodeLegendDraft[code][field] = value;
}

function escapeAttr(s){ return String(s).replace(/"/g,"&quot;"); }

function cancelPdfPreview(){
  $("pdfPreviewSection").classList.add("hidden");
  pdfParsedGrid = null; pdfCodeLegendDraft = {}; pdfDayWeekdayDraft = {};
  $("ttPdfFile").value = "";
}

async function confirmPdfTimetable(){
  try{
    if(!pdfParsedGrid){ return; }
    readGridFromInputs();
    const usedCodes = new Set();
    pdfParsedGrid.forEach(r=> r.cells.forEach(c=>{ if(c && c.trim()) usedCodes.add(c.trim()); }));
    const missingMapping = [...usedCodes].filter(c=> !pdfCodeLegendDraft[c]);
    if(missingMapping.length > 0){
      alert("Grid edit pannitinga, aana pudhu code(s) irukku: " + missingMapping.join(", ") + "\n'Re-scan Codes' button click pannunga, appuram mapping pannunga.");
      return;
    }
    const incomplete = [...usedCodes].filter(c=> !pdfCodeLegendDraft[c].department || !pdfCodeLegendDraft[c].year);
    if(incomplete.length > 0){ alert("Ella code kum Department & Year select pannunga: " + incomplete.join(", ")); return; }

    toast("Timetable save aagudhu...");
    const batch = db.batch();
    usedCodes.forEach(code=>{
      const leg = pdfCodeLegendDraft[code];
      const ref = db.collection("classCodeLegend").doc(code.toUpperCase());
      batch.set(ref, { code, department: leg.department, year: leg.year, isLab: !!leg.isLab, subject: leg.subject || code }, { merge:true });
    });
    let entryCount = 0;
    pdfParsedGrid.forEach(row=>{
      const dow = pdfDayWeekdayDraft[row.dayLabel];
      row.cells.forEach((code, idx)=>{
        if(!code || !code.trim()) return;
        const leg = pdfCodeLegendDraft[code.trim()];
        if(!leg || !leg.department || !leg.year) return;
        const period = `Period ${idx+1}`;
        const [startTime, endTime] = PERIOD_TIMES[period] || ["",""];
        const ref = db.collection("timetable").doc();
        batch.set(ref, {
          staffUsername: currentUser.username, staffName: currentUser.username,
          dayOfWeek: dow, period, startTime, endTime,
          department: leg.department, year: leg.year, section: "",
          subject: leg.subject || code, sourceCode: code, isLab: !!leg.isLab,
          createdAt: new Date().toISOString()
        });
        entryCount++;
      });
    });
    await batch.commit();
    toast(`Timetable upload aayiduchu ✅ ${entryCount} periods added`);
    cancelPdfPreview();
    loadMyTimetable();
    if(currentUser.role === "staff") initStaffNotifications();
  }catch(err){ alert("Save error: " + err.message); console.error(err); }
}

// ==========================================================
// "GO TO CLASS" NOTIFICATIONS
// Checks today's timetable and schedules an alert 5 minutes
// before each period starts, while the app tab is open.
// ==========================================================
let scheduledTimers = [];
let pendingClassAlert = null;

function clearScheduledTimers(){
  scheduledTimers.forEach(t=>clearTimeout(t));
  scheduledTimers = [];
}

async function initStaffNotifications(){
  clearScheduledTimers();
  if("Notification" in window && Notification.permission === "default"){
    try{ await Notification.requestPermission(); }catch(e){ /* ignore */ }
  }
  try{
    const today = new Date();
    const dow = today.getDay();
    const snap = await db.collection("timetable")
      .where("staffUsername","==",currentUser.username)
      .where("dayOfWeek","==",dow).get();
    snap.docs.forEach(d=>{
      const entry = { id: d.id, ...d.data() };
      const [h,m] = entry.startTime.split(":").map(Number);
      const startAt = new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m, 0);
      const fireAt = new Date(startAt.getTime() - 5*60000); // 5 min before period
      const delay = fireAt.getTime() - Date.now();
      if(delay > 0 && delay < 24*60*60*1000){
        scheduledTimers.push(setTimeout(()=>fireClassNotification(entry), delay));
      }
    });
  }catch(err){ console.error("Notification schedule error:", err); }
}

function fireClassNotification(entry){
  const msg = `${entry.subject} - ${entry.period} - ${entry.year} ${entry.department}${entry.section ? " "+entry.section : ""} ku pogunga!`;
  pendingClassAlert = entry;
  $("classAlertText").innerText = msg;
  $("classAlert").classList.remove("hidden");
  if("Notification" in window && Notification.permission === "granted"){
    const n = new Notification("Go to Class", { body: msg, icon: "icon-192.png" });
    n.onclick = () => { window.focus(); goToClassFromAlert(); };
  }
  try{ db.collection("notification_log").add({ timetableId: entry.id, staffUsername: currentUser.username, message: msg, firedAt: new Date().toISOString() }); }
  catch(e){ /* non-critical */ }
}

function dismissClassAlert(){
  $("classAlert").classList.add("hidden");
  pendingClassAlert = null;
}

function goToClassFromAlert(){
  if(!pendingClassAlert) return;
  const entry = pendingClassAlert;
  $("classAlert").classList.add("hidden");
  showPage("attendance");
  lockDeptYear("aDept","aYear");
  $("aDate").value = getAttendanceDateStr();
  $("aSubject").value = entry.subject;
  $("aDept").value = entry.department;
  $("aYear").value = entry.year;
  document.querySelectorAll("#periodChecks input").forEach(c=>{ c.checked = (c.value === entry.period); });
  checkPeriodLocks();
  loadAttendanceStudents();
  pendingClassAlert = null;
}

function renderDashboardChart(attendance, students){
  const weekCounts = {}, monthCounts = {};
  attendance.forEach(a=>{ weekCounts[a.week || "Unknown"] = (weekCounts[a.week || "Unknown"] || 0) + 1; monthCounts[a.month || "Unknown"] = (monthCounts[a.month || "Unknown"] || 0) + 1; });
  if(attendance.length===0){ students.forEach(s=>{ weekCounts[s.week || "Students"] = (weekCounts[s.week || "Students"] || 0) + 1; monthCounts[s.month || "Students"] = (monthCounts[s.month || "Students"] || 0) + 1; }); }
  const labels = [...new Set([...Object.keys(weekCounts), ...Object.keys(monthCounts)])].slice(-8);
  const weeklyData = labels.map(l=>weekCounts[l] || 0), monthlyData = labels.map(l=>monthCounts[l] || 0);
  if(chart) chart.destroy();
  chart = new Chart($("dashboardChart"),{type:"bar",data:{labels,datasets:[{label:"Weekly Count",data:weeklyData},{label:"Monthly Count",data:monthlyData}]},options:{responsive:true,scales:{y:{beginAtZero:true,ticks:{precision:0}}}}});
}
