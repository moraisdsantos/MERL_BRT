/**
 * SIDP · Base MERL — sincroniza esta planilha com o painel SIDP.
 *
 * Instalação (uma vez): Extensões > Apps Script, cole este arquivo, salve,
 * recarregue a planilha e use SIDP > Configurar conexão (cole o segredo de sincronização).
 * Depois: SIDP > Sincronizar agora, e SIDP > Ativar sincronização a cada hora.
 */
var SUPABASE_URL = 'https://vcatxiptyfodunbymuzv.supabase.co';
var SUPABASE_KEY = 'sb_publishable_3T5ug8lMC7HWC_YODDi3AA_T05O0qos'; // chave pública do painel
var FORM_TABS = { F3: 'Form 3', F4: 'Form 4', F5PRE: 'Form 5-1', F5POS: 'Form 5-2' };
var BRASIL = 'main_survey/A3aiv_Region_Province_in_Brazil';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('SIDP')
    .addItem('Sincronizar agora', 'sincronizarComAviso')
    .addItem('Ativar sincronização a cada hora', 'ativarAgendamento')
    .addSeparator()
    .addItem('Configurar conexão', 'configurar')
    .addToUi();
}

function configurar() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Conexão com o painel', 'Cole o segredo de sincronização:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var segredo = r.getResponseText().trim();
  if (!segredo) return;
  PropertiesService.getScriptProperties().setProperty('SIDP_SEGREDO', segredo);
  ui.alert('Conexão salva. Use SIDP > Sincronizar agora.');
}

function ativarAgendamento() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sincronizar') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sincronizar').timeBased().everyHours(1).create();
  SpreadsheetApp.getUi().alert('Pronto: a planilha sincroniza sozinha a cada hora.');
}

function sincronizarComAviso() {
  var ui = SpreadsheetApp.getUi();
  try {
    var r = sincronizar();
    ui.alert('Painel atualizado',
      r.turmas + ' turmas, ' + r.participantes + ' participantes, ' + r.respostas + ' respostas de formulários ('
      + r.respostas_ignoradas + ' ignoradas: outros países ou testes), ' + r.problemas + ' problemas.\n'
      + r.em_revisao + ' respostas aguardam vínculo na aba Vínculos.', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Não foi possível sincronizar', String(e.message || e), ui.ButtonSet.OK);
  }
}

function sincronizar() {
  var segredo = PropertiesService.getScriptProperties().getProperty('SIDP_SEGREDO');
  if (!segredo) throw new Error('Falta configurar a conexão (SIDP > Configurar conexão).');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone();
  var forms = {};
  Object.keys(FORM_TABS).forEach(function (code) {
    var linhas = lerAba(ss, FORM_TABS[code], tz, true);
    forms[code] = linhas.filter(function (o) { return o._uuid && o[BRASIL] && o[BRASIL] !== 'n/a'; });
  });
  var payload = {
    turmas: lerAba(ss, 'Turmas', tz),
    participantes: lerAba(ss, 'Participantes', tz),
    vinculos: lerAba(ss, 'Vínculos', tz),
    problemas: lerAba(ss, 'Problemas', tz, false, true),
    formularios: lerAba(ss, 'Formulários', tz),
    forms: forms
  };
  var resp = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/sync_from_sheet', {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: SUPABASE_KEY },
    payload: JSON.stringify({ p_secret: segredo, p_payload: payload }),
    muteHttpExceptions: true
  });
  var corpo = resp.getContentText();
  if (resp.getResponseCode() >= 300) {
    var msg = corpo;
    try { msg = JSON.parse(corpo).message || corpo; } catch (e) {}
    throw new Error(msg);
  }
  var r = JSON.parse(corpo);
  // problemas novos recebem o ID gerado no painel
  var aba = ss.getSheetByName('Problemas');
  (r.problemas_novos || []).forEach(function (p) {
    if (p.linha > 1) aba.getRange(p.linha, 1).setValue(p.id);
  });
  return r;
}

/** Lê uma aba como lista de objetos {cabeçalho: valor em texto}. */
function lerAba(ss, nome, tz, semVazios, comLinha) {
  var aba = ss.getSheetByName(nome);
  if (!aba || aba.getLastRow() < 2) return [];
  var valores = aba.getDataRange().getValues();
  var cab = valores[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var i = 1; i < valores.length; i++) {
    var o = {}, algum = false;
    for (var j = 0; j < cab.length; j++) {
      if (!cab[j]) continue;
      var t = texto(valores[i][j], tz);
      if (t !== '') algum = true;
      if (t !== '' || !semVazios) o[cab[j]] = t;
    }
    if (!algum) continue;
    if (comLinha) o._linha = i + 1;
    out.push(o);
  }
  return out;
}

function texto(v, tz) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    var hora = Utilities.formatDate(v, tz, 'HH:mm:ss');
    return hora === '00:00:00' ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : Utilities.formatDate(v, tz, "yyyy-MM-dd'T'HH:mm:ss");
  }
  return String(v).trim();
}
