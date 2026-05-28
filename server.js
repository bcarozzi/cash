const express = require('express');
const Firebird = require('node-firebird');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DB_OPTIONS = {
  host: 'localhost', port: 3050,
  database: 'aecdb',
  user: 'SYSDBA', password: 'masterkey',
  lowercase_keys: true, charset: 'WIN1252'
};

const DATA_FILE = path.join(__dirname, 'cashflow_data.json');

// ─── FORNITORI SPECIALI (override locale) ────────────────────────────────────
// Nomi case-insensitive (anche parziali). Aggiungere qui quando necessario.
// Fornitori esclusi da Fatture da Pagare (pagamento automatico, non gestiti manualmente)
const FORNITORI_ESCLUSI_SDI = [
  'amazon', 'unipoltech', 'ald automotive', 'iliad', 'wind tre', 'ca auto bank'
];

const FORNITORI_ESTERI_OVERRIDE = [
  'allis electric'
];
const FORNITORI_ADDEBITO_DIRETTO = [
  'sorgenia', 'unipoltech', 'cap holding', 'ca auto bank', 'ald automotive', 'iliad', 'wind tre'
];

function defaultSaldiBanche() {
  return {
    aggiornato_il: null,
    banche: [
      { id: 'bpm_20496', nome: 'Banco BPM', conto: 'C/C 20496',              iban: 'IT34S0503420504000000020496', bic: 'BAPPIT21810',   valuta: 'EUR', saldo: 0 },
      { id: 'bpm_36062', nome: 'Banco BPM', conto: 'C/C 36062 Fotovoltaico', iban: 'IT34S0503420504000000036062', bic: 'BAPPIT21810',   valuta: 'EUR', saldo: 0 },
      { id: 'bdm',       nome: 'BDM',        conto: 'C/C Principale',          iban: 'IT58B0542401601000001200206', bic: 'BPBAIT3BXXX',  valuta: 'EUR', saldo: 0 },
      { id: 'wise_eur',  nome: 'Wise',       conto: 'EUR',                     iban: 'BE83967250032115',           bic: 'TRWIBEB1XXX',   valuta: 'EUR', saldo: 0, vincoli: 0 },
      { id: 'wise_usd',  nome: 'Wise',       conto: 'USD',                     iban: 'ROUTING 026073150',          bic: 'ACC 311374358', valuta: 'USD', saldo: 0, vincoli: 0 }
    ]
  };
}

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!d.saldi_banche) d.saldi_banche = defaultSaldiBanche();
    return d;
  } catch {
    return { saldo_iniziale: 0, voci_manuali: [], saldi_banche: defaultSaldiBanche() };
  }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    Firebird.attach(DB_OPTIONS, (err, db) => {
      if (err) return reject(err);
      db.query(sql, params, (err, result) => {
        db.detach();
        if (err) return reject(err);
        resolve(result || []);
      });
    });
  });
}

// Per DML (UPDATE/INSERT/DELETE): transazione esplicita + commit
function execute(sql, params = []) {
  return new Promise((resolve, reject) => {
    Firebird.attach(DB_OPTIONS, (err, db) => {
      if (err) return reject(err);
      db.transaction(Firebird.ISOLATION_READ_COMMITTED, (err, tr) => {
        if (err) { db.detach(); return reject(err); }
        tr.query(sql, params, (err, result) => {
          if (err) {
            tr.rollback(() => db.detach());
            return reject(err);
          }
          tr.commit((err) => {
            db.detach();
            if (err) return reject(err);
            resolve(result || []);
          });
        });
      });
    });
  });
}

function fmtDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt)) return null;
  return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`;
}

function isoDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt)) return null;
  // Usa componenti LOCALI (Danea memorizza le date come mezzanotte locale →
  // in UTC diventano 22:00/23:00 del giorno precedente, a seconda di CET/CEST).
  // toISOString() sballa il giorno; getFullYear/getMonth/getDate lo tengono corretto.
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2,'0');
  const day = String(dt.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

// ─── GET CASHFLOW DATA ────────────────────────────────────
app.get('/api/cashflow', async (req, res) => {
  try {
    const data = loadData();
    const wiseSaldati = data.wise_saldati || {};

    // Query incassi (clienti, Importo > 0)
    const incassiRows = await query(`
      SELECT p."Importo", p."DataScad", p."IDAnagr",
             p."NomePagamDoc", p."IDDoc", a."Nome"
      FROM "TPrimaNota" p
      LEFT JOIN "TAnagrafica" a ON a."IDAnagr" = p."IDAnagr"
      WHERE p."Saldato" = 0 AND p."Importo" > 0
      ORDER BY p."DataScad" ASC
    `);

    // Query pagamenti fornitori — filtro IDENTICO a /api/wise-export
    const pagamentiRows = await query(`
      SELECT p."Importo", p."DataScad", p."IDAnagr",
             p."NomePagamDoc", p."IDDoc", a."Nome"
      FROM "TPrimaNota" p
      LEFT JOIN "TAnagrafica" a ON a."IDAnagr" = p."IDAnagr"
      WHERE p."Saldato" = 0
        AND p."Importo" < 0
        AND (p."CategPagamento" IS NULL OR p."CategPagamento" <> 'Riba')
      ORDER BY p."DataScad" ASC
    `);

    const incassi = incassiRows.map(r => ({
      data_scad: isoDate(r.datascad),
      data_fmt:  fmtDate(r.datascad),
      importo:   Math.abs(Number(r.importo) || 0),
      nome:      (r.nome || '').trim(),
      tipo_pagam:(r.nomepagamdoc || '').trim(),
      id_doc:    r.iddoc,
      tipo:      'incasso'
    }));

    // Raggruppa pagamenti per IDAnagr+DataScad (stesso fornitore stesso giorno = una riga)
    const pagByKey = {};
    pagamentiRows.forEach(r => {
      const imp = Math.abs(Number(r.importo) || 0);
      const key = String(r.idanagr) + '_' + isoDate(r.datascad);
      if (wiseSaldati[key]) return;
      if (!pagByKey[key]) {
        pagByKey[key] = {
          data_scad: isoDate(r.datascad),
          data_fmt:  fmtDate(r.datascad),
          importo:   imp,
          nome:      (r.nome || '').trim(),
          tipo_pagam:(r.nomepagamdoc || '').trim(),
          id_doc:    r.iddoc,
          tipo:      'pagamento'
        };
      } else {
        pagByKey[key].importo += imp;
      }
    });

    const pagamenti = Object.values(pagByKey).sort((a,b) => (a.data_scad||'') < (b.data_scad||'') ? -1 : 1);

    res.json({
      saldo_iniziale: data.saldo_iniziale,
      voci_manuali:   data.voci_manuali || [],
      incassi,
      pagamenti
    });
  } catch(e) {
    console.error('Errore cashflow:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET RIBA ────────────────────────────────────────────
app.get('/api/riba', async (req, res) => {
  try {
    const rows = await query(`
      SELECT p."IDPrimaNota", p."Importo", p."DataScad", p."Saldato",
             p."NomePagamDoc", p."RifPagam", p."DataPagam",
             p."IDAnagr", p."IDDoc",
             a."Nome"
      FROM "TPrimaNota" p
      LEFT JOIN "TAnagrafica" a ON a."IDAnagr" = p."IDAnagr"
      WHERE p."CategPagamento" = 'Riba'
        AND p."Saldato" = 0
      ORDER BY p."DataScad" ASC
    `);

    const data = loadData();
    const presentate = data.riba_presentate || {};

    const riba = rows.map(r => {
      const id = r.idprimanota;
      const imp = Number(r.importo) || 0;
      const info = presentate[id] || {};
      return {
        id,
        data_scad: isoDate(r.datascad),
        data_fmt: fmtDate(r.datascad),
        importo: Math.abs(imp),
        segno: imp >= 0 ? 1 : -1,
        nome: (r.nome || '').trim(),
        rata: (r.nomepagamdoc || '').trim(),
        rif: (r.rifpagam || '').trim(),
        id_doc: r.iddoc,
        presentata: info.presentata || false,
        data_presentazione: info.data_presentazione || null,
        banca: info.banca || null
      };
    });

    // Solo RiBa attive (clienti, importo > 0)
    const ribaAttive = riba.filter(r => r.segno > 0);

    // Raggruppa per data scadenza
    const byDate = {};
    ribaAttive.forEach(r => {
      const k = r.data_scad || 'N/D';
      if (!byDate[k]) byDate[k] = { data_scad: r.data_scad, data_fmt: r.data_fmt, items: [], totale: 0, presentate: 0 };
      byDate[k].items.push(r);
      byDate[k].totale += r.importo;
      if (r.presentata) byDate[k].presentate++;
    });

    const gruppi = Object.values(byDate).sort((a,b) => (a.data_scad||'') < (b.data_scad||'') ? -1 : 1);

    const totAttese     = ribaAttive.filter(r => !r.presentata).reduce((s,r) => s+r.importo, 0);
    const totPresentate = ribaAttive.filter(r =>  r.presentata).reduce((s,r) => s+r.importo, 0);

    res.json({ riba: ribaAttive, gruppi, totAttese, totPresentate });
  } catch(e) {
    console.error('Errore /api/riba:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET RIMESSE DIRETTE ─────────────────────────────────
app.get('/api/rimesse', async (req, res) => {
  try {
    const includiSaldate = req.query.includiSaldate === '1';
    const saldatoFilter  = includiSaldate ? '' : 'AND p."Saldato" = 0';
    const rows = await query(`
      SELECT p."IDPrimaNota", p."Importo", p."DataScad", p."DataPagam", p."Saldato",
             p."NomePagamDoc", p."RifPagam", p."IDAnagr", p."IDDoc",
             p."CategPagamento",
             a."Nome",
             d."NumDoc", d."DataDoc"
      FROM "TPrimaNota" p
      LEFT JOIN "TAnagrafica" a ON a."IDAnagr" = p."IDAnagr"
      LEFT JOIN "TDocTestate" d ON d."IDDoc" = p."IDDoc"
      WHERE p."Importo" <> 0
        AND (p."CategPagamento" <> 'Riba' OR p."CategPagamento" IS NULL)
        ${saldatoFilter}
      ORDER BY p."DataScad" ASC
    `);

    const rimesse = rows.map(r => ({
      id:        r.idprimanota,
      data_scad: isoDate(r.datascad),
      data_fmt:  fmtDate(r.datascad),
      importo:   Number(r.importo) || 0,  // mantiene segno: note di credito = negativo
      nome:      (r.nome || '').trim(),
      rata:      (r.nomepagamdoc || '').trim(),
      rif:       (r.rifpagam || '').trim(),
      fattura:   (r.numdoc || '').trim(),
      data_doc:  fmtDate(r.datadoc),
      data_doc_iso: isoDate(r.datadoc),
      // data pagamento: popolata solo se la scadenza è saldata in DB (TPrimaNota."DataPagam")
      data_pagam_iso: r.saldato ? isoDate(r.datapagam) : '',
      data_pagam_fmt: r.saldato ? fmtDate(r.datapagam) : '',
      tipo_pag:  (r.categpagamento || '—').trim(),
      id_doc:    r.iddoc,
      saldato_db: !!r.saldato
    }));

    const today = new Date(); today.setHours(0,0,0,0);
    const in30  = new Date(today); in30.setDate(in30.getDate() + 30);

    const totale    = rimesse.reduce((s,r) => s + r.importo, 0);
    const totScad   = rimesse.filter(r => r.data_scad && new Date(r.data_scad) < today).reduce((s,r) => s + r.importo, 0);
    const tot30     = rimesse.filter(r => r.data_scad && new Date(r.data_scad) >= today && new Date(r.data_scad) <= in30).reduce((s,r) => s + r.importo, 0);

    // Raggruppa per data scadenza
    const byDate = {};
    rimesse.forEach(r => {
      const k = r.data_scad || 'N/D';
      if (!byDate[k]) byDate[k] = { data_scad: r.data_scad, data_fmt: r.data_fmt, items: [], totale: 0 };
      byDate[k].items.push(r);
      byDate[k].totale += r.importo;
    });
    const gruppi = Object.values(byDate).sort((a,b) => (a.data_scad||'') < (b.data_scad||'') ? -1 : 1);

    const appData = loadData();
    const solleciti = appData.rimesse_solleciti || {};
    const saldati   = appData.rimesse_saldati   || {};

    // Arricchisci con dati locali. Se includiSaldate: tieni anche i saldati (DB o locali) marcandoli.
    const rimesseFilt = rimesse
      .filter(r => {
        const saldatoLocale = !!saldati[r.id];
        const pagata = r.saldato_db || saldatoLocale;
        return includiSaldate ? true : !pagata;
      })
      .map(r => {
        const saldatoLocale = saldati[r.id] || null;
        const pagata = r.saldato_db || !!saldatoLocale;
        return {
          ...r,
          data_sollecito:  solleciti[r.id]?.data  || '',
          descr_sollecito: solleciti[r.id]?.descr || '',
          pagata,
          data_saldo:      saldatoLocale?.data_saldo || '',
          saldo_dove:      saldatoLocale?.dove || ''
        };
      });

    // Totali: conta solo le NON pagate (le pagate sono "informative")
    const nonPagate = rimesseFilt.filter(r => !r.pagata);
    const totale2  = nonPagate.reduce((s,r) => s+r.importo, 0);
    const totScad2 = nonPagate.filter(r => r.data_scad && new Date(r.data_scad) < today).reduce((s,r) => s+r.importo, 0);
    const tot302   = nonPagate.filter(r => r.data_scad && new Date(r.data_scad) >= today && new Date(r.data_scad) <= in30).reduce((s,r) => s+r.importo, 0);

    const byDate2 = {};
    rimesseFilt.forEach(r => {
      const k = r.data_scad || 'N/D';
      if (!byDate2[k]) byDate2[k] = { data_scad: r.data_scad, data_fmt: r.data_fmt, items: [], totale: 0 };
      byDate2[k].items.push(r);
      if (!r.pagata) byDate2[k].totale += r.importo;
    });
    const gruppi2 = Object.values(byDate2).sort((a,b) => (a.data_scad||'') < (b.data_scad||'') ? -1 : 1);

    res.json({ rimesse: rimesseFilt, gruppi: gruppi2, totale: totale2, totScad: totScad2, tot30: tot302, includiSaldate });
  } catch(e) {
    console.error('Errore /api/rimesse:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── DIAGNOSTIC: tutte le primanota di un cliente (per debug) ─────────────
app.get('/api/rimesse/debug-cliente', async (req, res) => {
  try {
    const q = (req.query.nome || '').trim().toUpperCase();
    if (!q) return res.status(400).json({ error: 'usa ?nome=XXX' });
    const rows = await query(`
      SELECT p.*,
             a."Nome" AS "AnagNome",
             d."NumDoc" AS "DocNumDoc", d."DataDoc" AS "DocDataDoc"
      FROM "TPrimaNota" p
      LEFT JOIN "TAnagrafica" a ON a."IDAnagr" = p."IDAnagr"
      LEFT JOIN "TDocTestate" d ON d."IDDoc" = p."IDDoc"
      WHERE UPPER(a."Nome") LIKE ?
      ORDER BY p."DataScad" ASC
    `, ['%' + q + '%']);
    // Ritorna tutte le colonne (grezze) così vediamo cosa c'è davvero in TPrimaNota
    res.json({ count: rows.length, rows });
  } catch(e) {
    console.error('Errore debug-cliente:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET SALDI CLIENTI / FORNITORI a una data ──────────────────────────────
// Replica la logica Danea dell'elenco clienti/fornitori:
//
// 1) CLASSIFICAZIONE cliente vs fornitore:
//    - TipoDoc del documento è il classificatore primario.
//      I/F/V/J → vendita (lato cliente)  |  U/A → acquisto (lato fornitore)
//      N (nota credito): segno negativo = NCV (riduce credito cliente),
//                        segno positivo = NCA (riduce debito fornitore)
//    - Se TipoDoc mancante → flag Cliente/Fornitore di TAnagrafica
//    - Ultimo fallback: segno dell'importo
//
// 2) INCLUSIONE (scadenza ancora "aperta" alla data cutoff):
//    - saldato=0 → aperta ordinaria
//    - saldato=1 e DataPagam > cutoff → al cutoff era aperta (pagata dopo)
//    - saldato=1 e CategPagam='Riba' e DataScad > cutoff → Ri.Ba. presentata in banca
//      ma scadenza futura → in "BDM c/effetti" → ancora aperta contabilmente
//    - altrimenti (saldato=1 e DataPagam ≤ cutoff) → chiusa, escludi
app.get('/api/saldi-cli-forn', async (req, res) => {
  try {
    const today = (new Date()).toISOString().slice(0,10);
    const dataCli  = (req.query.dataCli  || today).slice(0,10);
    const dataForn = (req.query.dataForn || today).slice(0,10);

    const rows = await query(`
      SELECT p."IDPrimaNota", p."IDAnagr", p."Importo", p."DataScad", p."DataPagam",
             p."Saldato", p."IDDoc", p."CategPagamento",
             a."Nome" AS "AnagNome",
             a."Cliente" AS "AnagCliente",
             a."Fornitore" AS "AnagFornitore",
             d."DataDoc" AS "DocDataDoc",
             d."TipoDoc" AS "DocTipoDoc"
      FROM "TPrimaNota" p
      LEFT JOIN "TAnagrafica" a ON a."IDAnagr" = p."IDAnagr"
      LEFT JOIN "TDocTestate" d ON d."IDDoc" = p."IDDoc"
      WHERE p."Importo" <> 0
    `);

    const truthy = v => v === 1 || v === 'S' || v === 's' || v === true || v === '1';
    const mapCli  = {}; // IDAnagr -> { idAnagr, nome, saldo }
    const mapForn = {};

    // Classifica una riga come "vendita" (→cliente) o "acquisto" (→fornitore).
    // Ritorna true=vendita, false=acquisto.
    function classifica(r, importo) {
      const tipo = (r.doctipodoc || '').trim().toUpperCase();
      if (tipo) {
        // Acquisto: U=uscita, A=acquisto
        if (tipo.startsWith('U') || tipo.startsWith('A')) return false;
        // Vendita: F=fattura, I=incasso/vendita, V=vendita, J=giroconto vendita
        if (tipo.startsWith('F') || tipo.startsWith('I') || tipo.startsWith('V') || tipo.startsWith('J')) return true;
        // Nota credito: il segno distingue NCV da NCA
        if (tipo.startsWith('N')) return importo < 0;
        // TipoDoc sconosciuto → cadi nel fallback
      }
      const isCli  = truthy(r.anagcliente);
      const isForn = truthy(r.anagfornitore);
      if (isCli && !isForn)      return true;
      if (isForn && !isCli)      return false;
      return importo > 0; // fallback su segno
    }

    for (const r of rows) {
      const ddoc  = isoDate(r.docdatadoc);
      if (!ddoc) continue;                              // senza DataDoc non posizionabile
      const dpag  = isoDate(r.datapagam);
      const dscad = isoDate(r.datascad);
      const saldato = !!r.saldato;
      const categ = (r.categpagamento || '').trim().toLowerCase();
      const isRiba = categ === 'riba';
      const nome = (r.anagnome || '').trim();
      if (!nome) continue;
      const idAnagr = r.idanagr;
      const importo = Number(r.importo) || 0;

      const isSale = classifica(r, importo);
      const cutoff = isSale ? dataCli : dataForn;
      if (ddoc > cutoff) continue;                     // emesso dopo la data → ignora

      // Logica "aperta al cutoff":
      //  - non saldata
      //  - saldata dopo il cutoff (pagata in futuro rispetto alla data)
      //  - saldata (Ri.Ba. presentata in banca) con scadenza successiva al cutoff
      //    → ancora in "BDM Banca c/effetti" per Danea
      let aperta = false;
      if (!saldato) aperta = true;
      else if (dpag && dpag > cutoff) aperta = true;
      else if (isRiba && dscad && dscad > cutoff) aperta = true;

      if (!aperta) continue;

      const map = isSale ? mapCli : mapForn;
      if (!map[idAnagr]) map[idAnagr] = { idAnagr, nome, saldo: 0 };
      map[idAnagr].saldo += importo;
    }

    // Filtra saldi a zero (tolleranza 1 cent) e ordina ALFABETICAMENTE per controllo contabile
    const byNome = (a,b) => (a.nome || '').localeCompare(b.nome || '', 'it', { sensitivity: 'base' });
    const clienti   = Object.values(mapCli).filter(x => Math.abs(x.saldo) > 0.01).sort(byNome);
    const fornitori = Object.values(mapForn).filter(x => Math.abs(x.saldo) > 0.01).sort(byNome);

    const totaleCli  = clienti.reduce((s,x) => s + x.saldo, 0);
    const totaleForn = fornitori.reduce((s,x) => s + x.saldo, 0);

    res.json({ dataCli, dataForn, clienti, fornitori, totaleCli, totaleForn });
  } catch(e) {
    console.error('Errore /api/saldi-cli-forn:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── DEBUG: dump dettagliato per una anagrafica (saldi cli/forn) ────────────
// Mostra riga per riga: classificazione, filtro, inclusione/esclusione e motivo.
app.get('/api/saldi-cli-forn/debug', async (req, res) => {
  try {
    const q = (req.query.nome || '').trim().toUpperCase();
    if (!q) return res.status(400).json({ error: 'usa ?nome=XXX' });
    const today = (new Date()).toISOString().slice(0,10);
    const dataCli  = (req.query.dataCli  || today).slice(0,10);
    const dataForn = (req.query.dataForn || today).slice(0,10);
    const openOnly = req.query.openOnly === '1';
    const summary  = req.query.summary  === '1';

    const rows = await query(`
      SELECT p."IDPrimaNota", p."IDAnagr", p."Importo", p."DataScad", p."DataPagam",
             p."Saldato", p."IDDoc", p."CategPagamento", p."NomePagamDoc", p."Risorsa",
             a."Nome" AS "AnagNome",
             a."Cliente" AS "AnagCliente",
             a."Fornitore" AS "AnagFornitore",
             d."NumDoc" AS "DocNumDoc",
             d."DataDoc" AS "DocDataDoc",
             d."TipoDoc" AS "DocTipoDoc"
      FROM "TPrimaNota" p
      LEFT JOIN "TAnagrafica" a ON a."IDAnagr" = p."IDAnagr"
      LEFT JOIN "TDocTestate" d ON d."IDDoc" = p."IDDoc"
      WHERE UPPER(a."Nome") LIKE ?
      ORDER BY d."DataDoc" ASC, p."DataScad" ASC
    `, ['%' + q + '%']);

    const truthy = v => v === 1 || v === 'S' || v === 's' || v === true || v === '1';
    let saldoCli = 0, saldoForn = 0;
    // summary bucket: aperte_ordinarie | banca_effetti | chiuse
    const summaryBuckets = {
      aperte_ord_cli: { count: 0, sum: 0 },
      aperte_ord_forn: { count: 0, sum: 0 },
      banca_effetti_cli: { count: 0, sum: 0 },
      banca_effetti_forn: { count: 0, sum: 0 },
      chiuse: { count: 0, sum: 0 },
      scartate: { count: 0, sum: 0 }
    };
    // groupBy TipoDoc × segno × aperta (per capire classificazione NC)
    const byTipo = {}; // key: `${tipo}|${segno>0?'+':'-'}` → { count, sum, esempi: [first 3 num_doc] }
    const detail = rows.map(r => {
      const ddoc = isoDate(r.docdatadoc);
      const dpag = isoDate(r.datapagam);
      const dscad = isoDate(r.datascad);
      const saldato = !!r.saldato;
      const importo = Number(r.importo) || 0;
      const categ = (r.categpagamento || '').trim();
      const isRiba = categ.toLowerCase() === 'riba';
      const isCli  = truthy(r.anagcliente);
      const isForn = truthy(r.anagfornitore);
      const tipo = (r.doctipodoc || '').trim().toUpperCase();
      let isSale, classif;
      if (tipo.startsWith('U') || tipo.startsWith('A'))      { isSale = false; classif = `tipo=${tipo}→forn`; }
      else if (tipo && (tipo.startsWith('F') || tipo.startsWith('I') || tipo.startsWith('V') || tipo.startsWith('J')))
                                                              { isSale = true;  classif = `tipo=${tipo}→cli`; }
      else if (tipo.startsWith('N'))                          { isSale = importo < 0; classif = `NC→${isSale?'cli':'forn'} (segno)`; }
      else if (isCli && !isForn)                              { isSale = true;  classif = 'anag=cli'; }
      else if (isForn && !isCli)                              { isSale = false; classif = 'anag=forn'; }
      else                                                    { isSale = importo > 0; classif = 'fallback→segno'; }

      const cutoff = isSale ? dataCli : dataForn;

      // Bucket classification
      let bucket = null, included = true, reason = '';
      if (importo === 0)         { included = false; reason = 'importo=0'; bucket = 'scartate'; }
      else if (!ddoc)            { included = false; reason = 'no DataDoc'; bucket = 'scartate'; }
      else if (ddoc > cutoff)    { included = false; reason = `DataDoc ${ddoc} > cutoff ${cutoff}`; bucket = 'scartate'; }
      else if (!saldato) {
        // aperta ordinaria (mai pagata/presentata)
        bucket = isSale ? 'aperte_ord_cli' : 'aperte_ord_forn';
      }
      else if (saldato && dpag && dpag > cutoff) {
        // pagata dopo il cutoff: al cutoff era ancora aperta
        bucket = isSale ? 'aperte_ord_cli' : 'aperte_ord_forn';
      }
      else if (saldato && isRiba && dscad && dscad > cutoff) {
        // Ri.Ba. presentata in banca ma scadenza oltre cutoff → ancora in BDM Banca c/effetti
        bucket = isSale ? 'banca_effetti_cli' : 'banca_effetti_forn';
      }
      else {
        // saldato e pagato entro cutoff → chiusa
        included = false;
        reason = `Saldato, DataPagam ${dpag || '∅'} ≤ cutoff ${cutoff}`;
        bucket = 'chiuse';
      }

      if (bucket && summaryBuckets[bucket]) {
        summaryBuckets[bucket].count += 1;
        summaryBuckets[bucket].sum += importo;
      }

      // Group by TipoDoc × segno × aperta/chiusa (solo per capire le NC)
      if (bucket !== 'scartate') {
        const tk = `${r.doctipodoc || '?'}|${importo >= 0 ? '+' : '-'}|${included ? 'aperta' : 'chiusa'}`;
        if (!byTipo[tk]) byTipo[tk] = { tipo: r.doctipodoc, segno: importo >= 0 ? '+' : '-', stato: included ? 'aperta' : 'chiusa', count: 0, sum: 0, esempi: [] };
        byTipo[tk].count += 1;
        byTipo[tk].sum += importo;
        if (byTipo[tk].esempi.length < 3) byTipo[tk].esempi.push(r.docnumdoc);
      }

      if (included) {
        if (isSale) saldoCli  += importo;
        else        saldoForn += importo;
      }
      return {
        id: r.idprimanota,
        num_doc: r.docnumdoc,
        tipo_doc: r.doctipodoc,
        data_doc: ddoc,
        data_scad: dscad,
        data_pagam: dpag,
        saldato,
        importo,
        categ: r.categpagamento,
        risorsa: r.risorsa,
        rata: r.nomepagamdoc,
        anag_cli: r.anagcliente,
        anag_forn: r.anagfornitore,
        classif,
        is_sale: isSale,
        cutoff,
        bucket,
        included,
        reason
      };
    });

    // round summary
    for (const k in summaryBuckets) {
      summaryBuckets[k].sum = Math.round(summaryBuckets[k].sum * 100) / 100;
    }
    const byTipoArr = Object.values(byTipo).map(x => ({ ...x, sum: Math.round(x.sum*100)/100 }));

    const filtered = openOnly ? detail.filter(r => r.included) : detail;
    const payload = {
      query: q, dataCli, dataForn,
      count: rows.length,
      saldoCli: Math.round(saldoCli*100)/100,
      saldoForn: Math.round(saldoForn*100)/100,
      saldoNet: Math.round((saldoCli + saldoForn)*100)/100,
      summary: summaryBuckets,
      byTipo: byTipoArr
    };
    if (!summary) payload.rows = filtered;
    res.json(payload);
  } catch(e) {
    console.error('Errore debug saldi:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rimesse/sollecito', (req, res) => {
  const { id, data, descr } = req.body;
  if (!id) return res.status(400).json({ error: 'id mancante' });
  const appData = loadData();
  if (!appData.rimesse_solleciti) appData.rimesse_solleciti = {};
  appData.rimesse_solleciti[id] = { data: data||'', descr: descr||'', ts: new Date().toISOString() };
  saveData(appData);
  res.json({ ok: true });
});

app.post('/api/rimesse/saldato', (req, res) => {
  const { id, data_saldo, dove } = req.body;
  if (!id) return res.status(400).json({ error: 'id mancante' });
  const appData = loadData();
  if (!appData.rimesse_saldati) appData.rimesse_saldati = {};
  appData.rimesse_saldati[id] = { data_saldo: data_saldo||'', dove: dove||'', ts: new Date().toISOString() };
  saveData(appData);
  res.json({ ok: true });
});

// ─── GET RIBA FORNITORI (passive) ────────────────────────
app.get('/api/riba-fornitori', async (req, res) => {
  try {
    const rows = await query(`
      SELECT p."IDPrimaNota", p."Importo", p."DataScad", p."Saldato",
             p."NomePagamDoc", p."RifPagam",
             p."IDAnagr", p."IDDoc",
             a."Nome"
      FROM "TPrimaNota" p
      LEFT JOIN "TAnagrafica" a ON a."IDAnagr" = p."IDAnagr"
      WHERE p."CategPagamento" = 'Riba'
        AND p."Saldato" = 0
        AND p."Importo" < 0
      ORDER BY p."DataScad" ASC
    `);

    const riba = rows.map(r => ({
      id: r.idprimanota,
      data_scad: isoDate(r.datascad),
      data_fmt: fmtDate(r.datascad),
      importo: Math.abs(Number(r.importo) || 0),
      nome: (r.nome || '').trim(),
      rata: (r.nomepagamdoc || '').trim(),
      rif: (r.rifpagam || '').trim(),
      id_doc: r.iddoc
    }));

    // Raggruppa per data scadenza
    const byDate = {};
    riba.forEach(r => {
      const k = r.data_scad || 'N/D';
      if (!byDate[k]) byDate[k] = { data_scad: r.data_scad, data_fmt: r.data_fmt, items: [], totale: 0 };
      byDate[k].items.push(r);
      byDate[k].totale += r.importo;
    });
    const gruppi = Object.values(byDate).sort((a,b) => (a.data_scad||'') < (b.data_scad||'') ? -1 : 1);

    // Raggruppa per fornitore
    const byFornitore = {};
    riba.forEach(r => {
      const k = r.nome || 'N/D';
      if (!byFornitore[k]) byFornitore[k] = { nome: k, items: [], totale: 0 };
      byFornitore[k].items.push(r);
      byFornitore[k].totale += r.importo;
    });
    const fornitori = Object.values(byFornitore).sort((a,b) => b.totale - a.totale);

    const totale = riba.reduce((s,r) => s+r.importo, 0);
    const scadute = riba.filter(r => r.data_scad && r.data_scad < new Date().toISOString().slice(0,10)).reduce((s,r) => s+r.importo, 0);

    res.json({ riba, gruppi, fornitori, totale, scadute });
  } catch(e) {
    console.error('Errore /api/riba-fornitori:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GENERA FILE CBI RIBA ────────────────────────────────
app.post('/api/riba/genera-cbi', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });

    const SIA   = 'P6844';
    const ABI   = '05424';
    const CAB   = '01601';
    const CONTO = '000077061293';
    const CF_AEC   = '12520320156';
    const NOME_AEC = 'AEC INTERNATIONAL SRL';
    const IND_AEC  = 'AEC INTERNATIONAL SRL - 20045 LAINATE';
    const PROV_AEC = 'MI';

    const pad  = (s, n, c=' ') => String(s||'').toUpperCase().substring(0,n).padEnd(n, c);
    const padL = (s, n, c='0') => String(s||'').substring(0,n).padStart(n, c);
    const dateCBI = d => {
      if (!d) return '000000';
      const dt = new Date(d);
      return String(dt.getDate()).padStart(2,'0') +
             String(dt.getMonth()+1).padStart(2,'0') +
             String(dt.getFullYear()).slice(2);
    };
    const extractABICAB = coord => {
      if (!coord) return { abi:'00000', cab:'00000' };
      const m = coord.match(/ABI\s*(\d{5})\s*CAB\s*(\d{5})/i);
      if (m) return { abi: m[1], cab: m[2] };
      return { abi:'00000', cab:'00000' };
    };

    const rows = await query(
      `SELECT p."IDPrimaNota", p."Importo", p."DataScad",
              p."RifPagam", p."NomePagamDoc",
              a."Nome", a."Indirizzo", a."Cap", a."Citta", a."Prov",
              a."CodiceFiscale", a."PartitaIva", a."CoordBancarieDefault"
       FROM "TPrimaNota" p
       LEFT JOIN "TAnagrafica" a ON a."IDAnagr" = p."IDAnagr"
       WHERE p."IDPrimaNota" IN (${ids.join(',')})
         AND p."Saldato" = 0 AND p."Importo" > 0
       ORDER BY p."DataScad" ASC, a."Nome" ASC`
    );

    if (!rows.length) return res.status(404).json({ error: 'Nessuna RiBa trovata' });

    const dataCreaz  = dateCBI(new Date());
    const idDistinta = padL(Date.now().toString().slice(-19), 19);
    let records = [];
    let totCentesimi = 0;
    const nRiba = rows.length;
    const nRec  = 1 + nRiba * 7 + 1; // IB + 7*N + EF

    // ── Record IB ──────────────────────────────────────────
    // [0]=' ' [1:3]='IB' [3]='1' [4:9]=SIA(5) [9:14]=ABI(5) [14:20]=data(6)
    // [20:39]=ID(19) [39:113]=spazi(74) [113]='E' [114:120]=spazi(6)
    records.push(' IB1' + pad(SIA,5) + pad(ABI,5) + dataCreaz + idDistinta +
                 ' '.repeat(74) + 'E' + ' '.repeat(6));

    rows.forEach((r, idx) => {
      const prog    = padL(idx+1, 7);
      const imp     = Math.round(Math.abs(Number(r.importo)||0) * 100);
      totCentesimi += imp;
      const dataSc  = dateCBI(r.datascad);
      const rifArch = padL(Math.floor(Math.random()*9999999999), 10);
      const cfDeb   = (r.codicefiscale || r.partitaiva || '').trim();
      const causale = ((r.rifpagam || (r.nomepagamdoc ? 'RATA '+r.nomepagamdoc : 'PAGAMENTO FATTURA'))).toUpperCase();

      // ── Record 14 ──────────────────────────────────────
      // [0]=' ' [1:3]='14' [3:10]=prog(7) [10:22]=spazi(12) [22:28]=data(6)
      // [28]='3' [29:46]=importo(17) [46]='-' [47:52]=ABI(5) [52:57]=CAB(5)
      // [57:69]=conto(12) [69:79]=rif(10) [79:91]=spazi(12) [91]='1'
      // [92:97]=SIA(5) [97:119]=spazi(22) [119]='E'
      records.push(
        ' 14' + prog + ' '.repeat(12) + dataSc + '3' + padL(imp,17) + '-' +
        ABI + CAB + CONTO + rifArch +
        ' '.repeat(12) + '1' + SIA + ' '.repeat(22) + 'E'
      );

      // ── Record 20 ──────────────────────────────────────
      // [10:50]=nome cred(40) [50:58]=spazi(8) [58:96]=ind(38)
      // [96:98]=spazi [98:100]=prov? [100:120]=spazi
      // Analisi originale: [96:106]='        MI' → prov a pos 106 no...
      // Originale: '        AEC...LAINATE         MI              '
      // [50:58]='        ' [58:96]='AEC INTERNATIONAL SRL - 20045 LAINATE ' [96:106]='        MI' [106:120]=spazi
      records.push(
        ' 20' + prog + pad(NOME_AEC,40) +
        ' '.repeat(8) + pad(IND_AEC,38) +
        ' '.repeat(8) + pad(PROV_AEC,2) + ' '.repeat(14)
      );

      // ── Record 30 ──────────────────────────────────────
      // [10:50]=nome deb(40) [50:70]=spazi(20) [70:81]=CF(11) [81:120]=spazi(39)
      records.push(
        ' 30' + prog + pad(r.nome||'',40) +
        ' '.repeat(20) + pad(cfDeb,11) + ' '.repeat(39)
      );

      // ── Record 40 ──────────────────────────────────────
      // [10:35]=ind(25) [35:40]=spazi(5) [40:45]=CAP(5) [45:65]=citta(20)
      // [65:68]=spazi(3) [68:70]=prov(2) [70:120]=spazi(50)
      records.push(
        ' 40' + prog + pad(r.indirizzo||'',25) +
        ' '.repeat(5) + pad(r.cap||'',5) + pad(r.citta||'',20) +
        ' '.repeat(3) + pad(r.prov||'',2) + ' '.repeat(50)
      );

      // ── Record 50 ──────────────────────────────────────
      // [10:90]=causale(80) [90:100]=spazi(10) [100:111]=CF cred(11) [111:120]=spazi(9)
      records.push(
        ' 50' + prog + pad(causale,80) +
        ' '.repeat(10) + pad(CF_AEC,11) + ' '.repeat(9)
      );

      // ── Record 51 ──────────────────────────────────────
      // [10:20]=n.riba(10) [20:40]=nome cred(20) [40:120]=spazi(80)
      records.push(
        ' 51' + prog + padL(idx+1,10) +
        pad(NOME_AEC.substring(0,20),20) + ' '.repeat(80)
      );

      // ── Record 70 ──────────────────────────────────────
      // [10:100]=spazi(90) [100]='1' [101:120]=spazi(19)
      records.push(' 70' + prog + ' '.repeat(90) + '1' + ' '.repeat(19));
    });

    // ── Record EF ──────────────────────────────────────────
    // [0]=' ' [1:3]='EF' [3]='1' [4:9]=SIA(5) [9:14]=ABI(5) [14:20]=data(6)
    // [20:39]=ID(19) [39:45]=spazi(6) [45:53]=n.riba(8) [53:67]=tot.cent(14)
    // [67:75]=zeri(8) [75:89]=n.record(14) [89:113]=spazi(24) [113]='E' [114:120]=spazi(6)
    records.push(
      ' EF1' + pad(SIA,5) + pad(ABI,5) + dataCreaz + idDistinta +
      ' '.repeat(6) + padL(nRiba,8) + padL(totCentesimi,14) +
      padL(0,8) + padL(nRec,14) +
      ' '.repeat(24) + 'E' + ' '.repeat(6)
    );

    // Verifica lunghezze
    records.forEach((rec,i) => {
      if(rec.length !== 120) console.error(`Record ${i} (tipo ${rec.substring(1,3)}): ${rec.length} chars`);
    });

    const cbi = records.join('\r\n') + '\r\n';
    const oggi = new Date();
    const fname = `Riba_${String(oggi.getDate()).padStart(2,'0')}-${String(oggi.getMonth()+1).padStart(2,'0')}-${oggi.getFullYear()}.txt`;

    res.setHeader('Content-Type', 'text/plain; charset=latin-1');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(Buffer.from(cbi, 'latin1'));

  } catch(e) {
    console.error('Errore genera CBI:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── MARCA RIBA COME PRESENTATA / NON PRESENTATA ─────────
app.post('/api/riba/presenta', (req, res) => {
  const { ids, presentata, data_presentazione, banca } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  const data = loadData();
  if (!data.riba_presentate) data.riba_presentate = {};
  ids.forEach(id => {
    if (presentata) {
      data.riba_presentate[id] = {
        presentata: true,
        data_presentazione: data_presentazione || new Date().toISOString().slice(0,10),
        banca: banca || null
      };
    } else {
      delete data.riba_presentate[id];
    }
  });
  saveData(data);
  res.json({ ok: true, updated: ids.length });
});

// ─── GET WISE EXPORT ─────────────────────────────────────
app.get('/api/wise-export', async (req, res) => {
  try {
    const rows = await query(`
      SELECT p."IDPrimaNota", p."Importo", p."DataScad",
             p."NomePagamDoc", p."RifPagam", p."IDDoc",
             p."IDAnagr",
             a."Nome", a."Email", a."CoordBancarieDefault", a."Nazione",
             (SELECT FIRST 1 d."Pagam_CoordBancarie"
              FROM "TDocTestate" d
              WHERE d."IDAnagr" = p."IDAnagr"
                AND d."Pagam_CoordBancarie" IS NOT NULL
                AND d."Pagam_CoordBancarie" <> ''
              ORDER BY d."IDDoc" DESC) AS "DocCoordBancarie"
      FROM "TPrimaNota" p
      LEFT JOIN "TAnagrafica" a ON a."IDAnagr" = p."IDAnagr"
      WHERE p."Saldato" = 0
        AND p."Importo" < 0
        AND (p."CategPagamento" IS NULL OR p."CategPagamento" <> 'Riba')
      ORDER BY p."DataScad" ASC
    `);

    // Regex estrazione IBAN
    const ibanRegex = /[A-Z]{2}\d{2}[A-Z0-9 ]{11,30}/;

    // Carica dati locali AEC Cash
    const data = loadData();
    const ibanManuali = data.wise_iban_manuali || {};
    const wiseSaldati = data.wise_saldati || {}; // IDPrimaNota già pagati localmente

    const voci = rows.map(r => {
      // Priorità: 1) Pagam_CoordBancarie da ultima fattura, 2) CoordBancarieDefault anagrafica
      const coordRaw = (r.doccoordbancarie || r.coordbancariedefault || '').trim();
      const match = coordRaw.match(ibanRegex);
      const ibanDanea = match ? match[0].replace(/\s/g, '') : null;
      const ibanManuale = ibanManuali[String(r.idanagr)] || null;
      const iban = ibanDanea || ibanManuale;

      // Prima email (separatore ; o ,)
      const emailRaw = (r.email || '').trim();
      const email = emailRaw.split(/[;,]/)[0].trim() || null;

      // Fornitore estero: nazione presente e diversa da Italia → IBAN non richiesto
      const naz = (r.nazione || '').trim().toLowerCase();
      const nomeL = (r.nome || '').toLowerCase();
      const isEsteroNazione = naz !== '' && naz !== 'italia' && naz !== 'it';
      const isEsteroOverride = FORNITORI_ESTERI_OVERRIDE.some(p => nomeL.includes(p.toLowerCase()));
      const isEstero = isEsteroNazione || isEsteroOverride;
      const isAddebitoDiretto = FORNITORI_ADDEBITO_DIRETTO.some(p => nomeL.includes(p.toLowerCase()));
      // Se estero override: ignora IBAN da Danea (potrebbe essere un IBAN inserito erroneamente)
      const ibanEff = isEsteroOverride ? null : iban;

      return {
        id: r.idprimanota,
        id_anagr: r.idanagr,
        nome: (r.nome || '').trim(),
        email,
        importo: Math.abs(Number(r.importo) || 0),
        data_scad: isoDate(r.datascad),
        data_fmt: fmtDate(r.datascad),
        rata: (r.nomepagamdoc || '').trim(),
        rif: (r.rifpagam || '').trim(),
        coord_raw: coordRaw,
        iban: ibanEff,
        iban_manuale: !!ibanManuale && !isEsteroOverride,
        iban_ok: !!ibanEff || isEstero || isAddebitoDiretto,
        estero: isEstero,
        addebito_diretto: isAddebitoDiretto,
        nazione: (r.nazione || '').trim()
      };
    });

    // Escludi pagamenti già saldati, spostati in Fatture da Pagare o nascosti manualmente
    const wiseSpostate = data.wise_spostate || {};
    const wiseNascoste = data.wise_nascoste || {};
    const vociFiltrate = voci.filter(v =>
      !wiseSaldati[String(v.id)] &&
      !wiseSpostate[v.id_anagr + '_' + v.data_scad] &&
      !wiseNascoste[v.id_anagr + '_' + v.data_scad]
    );

    // Aggrega per fornitore (stesso IDAnagr) — somma importi stessa scadenza
    const byAnagr = {};
    vociFiltrate.forEach(v => {
      const k = v.id_anagr + '_' + v.data_scad;
      if (!byAnagr[k]) {
        byAnagr[k] = { ...v, importo: 0, ids: [], rate: [] };
      }
      byAnagr[k].importo += v.importo;
      byAnagr[k].ids.push(v.id);
      if (v.rata) byAnagr[k].rate.push(v.rata);
    });

    const righe = Object.values(byAnagr).sort((a,b) => (a.data_scad||'') < (b.data_scad||'') ? -1 : 1);
    const totale = righe.reduce((s,r) => s+r.importo, 0);
    const senzaIban = righe.filter(r => !r.iban_ok && !r.estero && !r.addebito_diretto).length;

    res.json({ righe, totale, senzaIban });
  } catch(e) {
    console.error('Errore /api/wise-export:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── SALVA IBAN MANUALE FORNITORE ────────────────────────
app.post('/api/wise-iban', (req, res) => {
  const { id_anagr, iban } = req.body;
  if (!id_anagr) return res.status(400).json({ error: 'id_anagr required' });
  const data = loadData();
  if (!data.wise_iban_manuali) data.wise_iban_manuali = {};
  if (iban) {
    data.wise_iban_manuali[String(id_anagr)] = iban.replace(/\s/g,'').toUpperCase();
  } else {
    delete data.wise_iban_manuali[String(id_anagr)];
  }
  saveData(data);
  res.json({ ok: true });
});

// ─── GET OPERAZIONI IN CORSO ─────────────────────────────
app.get('/api/operazioni', (req, res) => {
  const data = loadData();
  res.json(data.operazioni_in_corso || []);
});

// ─── ADD OPERAZIONE IN CORSO ──────────────────────────────
app.post('/api/operazioni', (req, res) => {
  const data = loadData();
  if (!data.operazioni_in_corso) data.operazioni_in_corso = [];
  const op = {
    id: Date.now(),
    banca: req.body.banca || '',
    tipo: req.body.tipo || 'uscita',
    data: req.body.data || '',
    descrizione: req.body.descrizione || '',
    importo: Math.abs(Number(req.body.importo) || 0)
  };
  data.operazioni_in_corso.push(op);
  saveData(data);
  res.json({ ok: true, op });
});

// ─── DELETE OPERAZIONE IN CORSO ───────────────────────────
app.delete('/api/operazioni/:id', (req, res) => {
  const data = loadData();
  data.operazioni_in_corso = (data.operazioni_in_corso || []).filter(o => o.id !== Number(req.params.id));
  saveData(data);
  res.json({ ok: true });
});

// ─── SEGNA PAGATI (tracking locale AEC Cash + tentativo Danea) ──────────
app.post('/api/wise/segna-pagati', async (req, res) => {
  try {
    const { ids, data_pagamento } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });

    const safeIds = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0);
    if (!safeIds.length) return res.status(400).json({ error: 'ids non validi' });

    const dataPag = (data_pagamento || new Date().toISOString().slice(0,10)).slice(0,10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataPag)) return res.status(400).json({ error: 'formato data non valido' });

    // ── 1) Leggi dettagli da Danea per lo storico ─────────────────────────
    let dettagli = [];
    try {
      dettagli = await query(`
        SELECT p."IDPrimaNota", p."IDDoc", p."Importo", p."DataScad",
               p."NomePagamDoc", p."RifPagam",
               a."Nome"
        FROM "TPrimaNota" p
        LEFT JOIN "TAnagrafica" a ON a."IDAnagr" = p."IDAnagr"
        WHERE p."IDPrimaNota" IN (${safeIds.join(',')})
      `);
    } catch(e) { console.warn('Lettura dettagli fallita:', e.message); }

    // ── 2) TRACKING LOCALE con storico completo ────────────────────────────
    const data = loadData();
    if (!data.wise_saldati) data.wise_saldati = {};
    if (!data.wise_storico) data.wise_storico = [];
    const saldatoIl = new Date().toISOString();

    // Salva nel dizionario (per filtro rapido)
    safeIds.forEach(id => {
      const det = dettagli.find(d => d.idprimanota === id) || {};
      data.wise_saldati[String(id)] = {
        data_pagamento: dataPag,
        saldato_il: saldatoIl,
        nome: (det.nome || '').trim(),
        importo: Math.abs(Number(det.importo) || 0),
        id_doc: det.iddoc || null,
        rata: (det.nomepagamdoc || '').trim(),
        rif: (det.rifpagam || '').trim()
      };
    });

    // Salva nello storico (array cronologico, mai cancellato)
    data.wise_storico.push({
      batch_id: saldatoIl,
      data_pagamento: dataPag,
      saldato_il: saldatoIl,
      pagamenti: safeIds.map(id => {
        const det = dettagli.find(d => d.idprimanota === id) || {};
        return {
          id,
          nome: (det.nome || '').trim(),
          importo: Math.abs(Number(det.importo) || 0),
          data_scad: det.datascad ? new Date(det.datascad).toISOString().slice(0,10) : null,
          id_doc: det.iddoc || null,
          rata: (det.nomepagamdoc || '').trim(),
          rif: (det.rifpagam || '').trim()
        };
      }),
      totale: dettagli.reduce((s, d) => s + Math.abs(Number(d.importo) || 0), 0)
    });
    saveData(data);
    console.log('Tracking locale salvato per IDs:', safeIds);

    // ── 3) TENTATIVO AGGIORNAMENTO DANEA (best-effort) ────────────────────
    const daneaErrors = [];
    try {
      await execute(`UPDATE "TPrimaNota" SET "Saldato" = 1, "DataPagam" = '${dataPag}' WHERE "IDPrimaNota" IN (${safeIds.join(',')}) AND "Saldato" = 0`);
      const idDocs = [...new Set(dettagli.map(r => r.iddoc).filter(Boolean))];
      for (const idDoc of idDocs) {
        const safeIdDoc = parseInt(idDoc, 10);
        if (isNaN(safeIdDoc)) continue;
        const doc = await query(`SELECT "TotDoc" FROM "TDocTestate" WHERE "IDDoc" = ${safeIdDoc}`);
        if (!doc.length) continue;
        const totDoc = doc[0].totdoc || 0;
        await execute(`UPDATE "TDocTestate" SET "Pagam_ImportoSaldato" = ${totDoc}, "Pagam_ImportoDaSaldare" = 0, "Pagam_Saldato" = 1, "Pagam_ShowForzaSaldato" = 1, "Pagam_ForzaSaldato" = 1 WHERE "IDDoc" = ${safeIdDoc}`);
      }
    } catch(e) {
      daneaErrors.push(e.message);
      console.warn('Aggiornamento Danea fallito (non critico):', e.message);
    }

    res.json({
      ok: true,
      aggiornati: safeIds.length,
      tracking_locale: 'salvato',
      danea_db: daneaErrors.length ? 'errore (non critico): ' + daneaErrors.join('; ') : 'aggiornato'
    });
  } catch(e) {
    console.error('Errore segna-pagati:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── STORICO PAGAMENTI WISE ──────────────────────────────────────────────
app.get('/api/wise/storico', (req, res) => {
  const data = loadData();
  const commenti = data.storico_commenti || {};
  const storico = (data.wise_storico || []).slice().reverse().map(b => ({...b, commento: commenti[b.batch_id] || ''}));
  res.json({ storico });
});

// ─── RIMUOVI DA SALDATI LOCALI (per correggere errori) ──────────────────
app.post('/api/wise/annulla-saldato', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
  const data = loadData();
  if (!data.wise_saldati) data.wise_saldati = {};
  ids.forEach(id => delete data.wise_saldati[String(parseInt(id, 10))]);
  saveData(data);
  res.json({ ok: true, rimossi: ids.length });
});


// ─── NASCONDI RIGA DA PAGAMENTI FORNITORI ────────────────────────────────────
app.post('/api/wise-nascondi', (req, res) => {
  const { rowKey, ripristina } = req.body;
  if (!rowKey) return res.status(400).json({ error: 'rowKey required' });
  const data = loadData();
  if (!data.wise_nascoste) data.wise_nascoste = {};
  if (ripristina) delete data.wise_nascoste[rowKey];
  else data.wise_nascoste[rowKey] = new Date().toISOString();
  saveData(data);
  res.json({ ok: true });
});

// ─── Helper: calcola rate da PagamentoDefault + DataDoc ──────────────────────
// Ritorna array di { giorni, scadenza } — una o più rate
// Logica:
//   - DFFM / DFF.M. / F.M. / FM → parti dall'ultimo giorno del mese fattura
//   - "60/90 gg" → due rate (metà + metà)
//   - "+10"      → giorni extra aggiunti ad ogni rata
//   - "vista"    → scadenza = data fattura
function calcolaRateDaPagamento(dataDoc, pagamentoDefault) {
  if (!dataDoc) return [{ scadenza: null, quota: 1 }];
  const str = (pagamentoDefault || '').toLowerCase();

  // Pagamento immediato (esplicito)
  if (str.includes('vista') || str.includes('advance') || str.includes('anticipo') || str.includes('subito') || str.includes('immediat')) {
    return [{ scadenza: new Date(dataDoc).toISOString().slice(0,10), quota: 1 }];
  }

  // Nessun termine di pagamento noto → default 30gg (non usare dataDoc come scadenza)
  if (!str) {
    const d = new Date(dataDoc);
    d.setDate(d.getDate() + 30);
    return [{ scadenza: d.toISOString().slice(0,10), quota: 1 }];
  }

  // Fine Mese?
  const isFineMese = str.includes('dff') || str.includes('f.m.') || /\bfm\b/.test(str) || str.includes('fine mese');

  // Giorni extra espliciti (es. "+10")
  const matchExtra = str.match(/\+\s*(\d+)/);
  const extra = matchExtra ? parseInt(matchExtra[1], 10) : 0;

  // Cerca pattern "60/90" o "30/60/90" (rate multiple)
  const matchMulti = str.match(/([\d]+(?:\/[\d]+)+)\s*gg/);
  if (matchMulti) {
    const valori = matchMulti[1].split('/').map(Number);
    const nRate = valori.length;
    return valori.map(g => {
      let base = new Date(dataDoc);
      if (isFineMese) base = new Date(base.getFullYear(), base.getMonth() + 1, 0);
      base.setDate(base.getDate() + g + extra);
      return { scadenza: base.toISOString().slice(0,10), quota: 1 / nRate };
    });
  }

  // Singola rata
  const matchGiorni = str.match(/(\d+)/);
  const giorni = matchGiorni ? parseInt(matchGiorni[1], 10) : 30;
  let base = new Date(dataDoc);
  if (isFineMese) base = new Date(base.getFullYear(), base.getMonth() + 1, 0);
  base.setDate(base.getDate() + giorni + extra);
  return [{ scadenza: base.toISOString().slice(0,10), quota: 1 }];
}

// ─── FATTURE SDI: lista da pagare ────────────────────────────────────────────
// Helper: estrae DataScadenzaPagamento dall'XML mappa server-side
function getXmlScadenza(cf, piva, numdoc, xmlMap) {
  if (!xmlMap || !Object.keys(xmlMap).length) return null;
  const normKey = (id, num) =>
    (id||'').replace(/\s/g,'').toUpperCase() + '_' +
    (num||'').trim().toUpperCase().replace(/\s+/g,'-');
  const normId  = (id) => (id||'').replace(/\s/g,'').toUpperCase();
  const ids = [cf, piva].filter(Boolean);
  for (const id of ids) {
    const d = xmlMap[normKey(id, numdoc)] || xmlMap[normId(id)];
    if (d && d.pagamento && d.pagamento.scadenza) {
      // Formato XML: DD/MM/YYYY → ISO YYYY-MM-DD
      const s = d.pagamento.scadenza.trim();
      const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (m) return `${m[3]}-${m[2]}-${m[1]}`;
      // Già ISO o altro formato leggibile
      const dt = new Date(s);
      if (!isNaN(dt)) return dt.toISOString().slice(0,10);
    }
  }
  return null;
}

app.get('/api/fatture-sdi', async (req, res) => {
  try {
    const data = loadData();
    const sdiSaldati     = data.sdi_saldati     || {};
    const sdiScadenze    = data.sdi_scadenze    || {};
    const sdiControllate = data.sdi_controllate || {};
    const fattureXml     = data.fatture_xml     || {};

    // Query 1: fatture TAgyo non ancora registrate in Danea
    // Niente filtro data in SQL (Firebird è sensibile al formato) — filtriamo in JS
    let rows;
    try {
      rows = await query(`SELECT * FROM "TAgyo" WHERE "Acq" = 1 ORDER BY "DataRicezione" DESC`);
    } catch(e1) {
      return res.status(500).json({ error: 'Query TAgyo fallita', detail: e1.message });
    }

    // Filtro data in JS: solo fatture ricevute dal 01/04/2026
    const cutoff = new Date('2026-04-01');
    rows = rows.filter(r => {
      if (!r.dataricezione) return false;
      return new Date(r.dataricezione) >= cutoff;
    });

    // Carico TDocTestate solo per IBAN ultima fattura (non più per anti-doppione)
    const normStr = (s) => (s || '').toString().trim().toUpperCase().replace(/\s+/g, '');
    const normDate = (d) => {
      if (!d) return '';
      try {
        const dt = new Date(d);
        return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
      } catch { return ''; }
    };
    const docIbanByIdAnagr = {};
    let docRowsAll = [];
    let anRows = [];
    try {
      const res2 = await Promise.all([
        query(`SELECT "IDDoc","NumDoc","DataDoc","IDAnagr","Pagam_CoordBancarie" FROM "TDocTestate" ORDER BY "IDDoc" DESC`),
        query(`SELECT * FROM "TAnagrafica"`)
      ]);
      docRowsAll = res2[0];
      anRows = res2[1];
    } catch(eLoad) {
      console.warn('Caricamento TDocTestate/TAnagrafica fallito:', eLoad.message);
    }

    // IBAN ultima fattura per IDAnagr (TDocTestate ordinato IDDoc DESC → primo trovato = più recente)
    docRowsAll.forEach(d => {
      if (d.idanagr != null && !docIbanByIdAnagr[d.idanagr]) {
        const coord = (d.pagam_coordbancarie || '').trim();
        if (coord) docIbanByIdAnagr[d.idanagr] = coord;
      }
    });

    // ── DEDUP INTERNO TAGYO ──
    // TAgyo può contenere più righe per la stessa fattura (IDAgyo diversi).
    // Teniamo solo il primo (IDAgyo più basso = più vecchio) per ogni chiave CF/PIVA+NumDoc+DataDoc.
    {
      const seen = new Set();
      rows = rows.filter(r => {
        const num     = normStr(r.numdoc);
        const dataKey = normDate(r.datadoc);
        const cf2     = normStr(r.codicefiscale);
        const piva2   = normStr(r.partitaiva);
        const primary = cf2 || piva2;
        if (!primary || !num || !dataKey) return true; // tieni se non abbiamo chiave
        const k = primary + '|' + num + '|' + dataKey;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    // ── ESCLUSE MANUALMENTE ──
    const sdiEscluse = data.sdi_escluse || {};
    rows = rows.filter(r => !sdiEscluse[r.idagyo]);

    // Mappe pagamento/IBAN per anagrafica fornitori
    const pagMap  = {};
    const ibanMap = {};
    const ibanRegex = /[A-Z]{2}\d{2}[A-Z0-9 ]{11,30}/;
    const sdiIbanManuali = data.sdi_iban_manuali || {};
    const sdiNote        = data.sdi_note        || {};

    try {
      anRows.forEach(r => {
        // Includi solo fornitori (campo Fornitore: 'S', 1, true — accetta qualsiasi valore truthy)
        const isFornitore = r.fornitore == 1 || r.fornitore === 'S' || r.fornitore === true;
        if (!isFornitore) return;
        const pag      = r.pagamentodefault || null;
        // Priorità: 1) Pagam_CoordBancarie da ultima fattura, 2) CoordBancarieDefault anagrafica
        const coordDoc = docIbanByIdAnagr[r.idanagr] || '';
        const coordRaw = (coordDoc || r.coordbancariedefault || '').trim();
        const match    = coordRaw.match(ibanRegex);
        const ibanDb   = match ? match[0].replace(/\s/g, '') : null;
        const keys = [];
        if (r.partitaiva    && (r.partitaiva    + '').trim()) keys.push((r.partitaiva    + '').trim());
        if (r.codicefiscale && (r.codicefiscale + '').trim()) keys.push((r.codicefiscale + '').trim());
        keys.forEach(k => {
          pagMap[k] = pag;
          if (ibanDb) ibanMap[k] = ibanDb;
        });
      });
    } catch(e2) {
      // Non bloccare se TAnagrafica fallisce: le scadenze saranno null (impostabili a mano)
      console.warn('TAnagrafica query fallita:', e2.message);
    }

    // Escludi fornitori a pagamento automatico
    rows = rows.filter(r => {
      const nomeL = (r.nome || '').toLowerCase();
      return !FORNITORI_ESCLUSI_SDI.some(p => nomeL.includes(p));
    });

    // Escludi autofatture estero (numeri con /RC = reverse charge, non da pagare)
    rows = rows.filter(r => !String(r.numdoc || '').toUpperCase().includes('/RC'));

    const fatture = [];
    rows.filter(r => !sdiSaldati[r.idagyo]).forEach(r => {
      const dataDoc       = r.datadoc ? new Date(r.datadoc) : null;
      const importoTot    = Math.abs(Number(r.totdovuto) || 0);
      const cf            = (r.codicefiscale || '').trim();
      const piva          = (r.partitaiva || '').trim();
      const azCf          = (r.az_codicefiscale || '').trim(); // P.IVA/CF aziendale in TAgyo
      const pagamento     = pagMap[cf] || pagMap[piva] || pagMap[azCf] || null;
      const rate          = calcolaRateDaPagamento(dataDoc, pagamento);
      const nRate         = rate.length;

      // Scadenza da XML (più precisa della stima da TAnagrafica)
      const numdocTrim = (r.numdoc || '').trim();
      const xmlScad = getXmlScadenza(cf, piva, numdocTrim, fattureXml);

      rate.forEach((rata, idx) => {
        const rataId       = nRate > 1 ? `${r.idagyo}_r${idx+1}` : r.idagyo;
        const scadOverride = sdiScadenze[rataId] || null;
        const nomeL = (r.nome || '').toLowerCase();
        const isAddebitoDiretto = FORNITORI_ADDEBITO_DIRETTO.some(p => nomeL.includes(p.toLowerCase()));
        // Priorità: 1) override manuale, 2) XML DataScadenzaPagamento, 3) calcolata
        const scadFinale = scadOverride || xmlScad || rata.scadenza || null;
        fatture.push({
          id:              rataId,
          id_agyo:         r.idagyo,
          rata_n:          nRate > 1 ? `${idx+1}/${nRate}` : null,
          nome:            (r.nome || '').trim(),
          cf:              cf,
          piva:            piva,
          numdoc:          numdocTrim,
          tipodoc:         (r.tipodocfe || '').trim(),
          data_doc:        dataDoc ? dataDoc.toISOString().slice(0,10) : null,
          data_ricezione:  r.dataricezione ? new Date(r.dataricezione).toISOString().slice(0,10) : null,
          pagamento_desc:  (pagamento || '').trim(),
          scadenza:        scadFinale,
          scadenza_manual: !!scadOverride,
          scadenza_da_xml: !scadOverride && !!xmlScad,
          importo:         Math.round(importoTot * rata.quota * 100) / 100,
          iban:            ibanMap[cf] || ibanMap[piva] || ibanMap[azCf] || null,
          iban_manuale:    sdiIbanManuali[cf] || sdiIbanManuali[piva] || sdiIbanManuali[azCf] || null,
          note:            sdiNote[rataId] || '',
          addebito_diretto: isAddebitoDiretto,
          controllata:     !!sdiControllate[rataId]
        });
      });
    });

    // ── Aggiungi voci manuali (spostate da Pagamenti Fornitori) ──
    const sdiManuali = data.sdi_manuali || [];
    sdiManuali.forEach(m => {
      if (sdiSaldati[m.id]) return; // già segnata come pagata
      if (sdiEscluse[m.id]) return; // nascosta manualmente
      const mNomeL = (m.nome || '').toLowerCase();
      if (FORNITORI_ESCLUSI_SDI.some(p => mNomeL.includes(p))) return; // fornitore escluso
      const scadOverride = sdiScadenze[m.id] || null;
      fatture.push({
        ...m,
        scadenza:        scadOverride || m.scadenza || null,
        scadenza_manual: !!scadOverride,
        note:            sdiNote[m.id] || m.note || '',
        controllata:     !!sdiControllate[m.id],
        iban_manuale:    sdiIbanManuali[m.cf] || sdiIbanManuali[m.piva] || m.iban_manuale || null,
        manuale:         true
      });
    });

    res.json({ fatture, totale: fatture.reduce((s, f) => s + f.importo, 0) });
  } catch(e) { res.status(500).json({ error: e.message, stack: e.stack }); }
});

// ─── WISE → SPOSTA IN FATTURE DA PAGARE ──────────────────────────────────────
app.post('/api/wise-sposta-in-sdi', (req, res) => {
  try {
    const { riga } = req.body; // riga = oggetto Wise row completo dal client
    if (!riga || !riga.id_anagr) return res.status(400).json({ error: 'riga required' });
    const chiave = String(riga.id_anagr) + '_' + (riga.data_scad || '');
    const id = 'MAN_' + chiave;
    const data = loadData();
    // Nascondi da Pagamenti Fornitori
    if (!data.wise_spostate) data.wise_spostate = {};
    data.wise_spostate[chiave] = new Date().toISOString();
    // Aggiungi a sdi_manuali (evita duplicati)
    if (!data.sdi_manuali) data.sdi_manuali = [];
    if (!data.sdi_manuali.find(m => m.id === id)) {
      data.sdi_manuali.push({
        id,
        id_agyo:         id,
        nome:            riga.nome || '',
        cf:              riga.cf || '',
        piva:            riga.piva || '',
        numdoc:          riga.rata || riga.rif || '',
        tipodoc:         '',
        data_doc:        riga.data_scad || null,
        data_ricezione:  null,
        pagamento_desc:  '',
        scadenza:        riga.data_scad || null,
        importo:         riga.importo || 0,
        iban:            riga.iban || null,
        iban_manuale:    null,
        note:            riga.rif || '',
        addebito_diretto: !!riga.addebito_diretto,
        controllata:     false
      });
    }
    saveData(data);
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── ALLIS ELECTRIC: gestione scadenze manuali ───────────────────────────────
// Importa le scadenze Allis da TPrimaNota (Pagamenti Fornitori) → allis_scadenze
// Aggiunge solo voci non già presenti (per scadenza+importo), non sovrascrive esistenti
app.post('/api/allis-pagamenti/import-from-wise', async (req, res) => {
  try {
    const rows = await query(`
      SELECT p."IDPrimaNota", p."Importo", p."DataScad",
             p."NomePagamDoc", p."RifPagam", p."IDDoc", p."IDAnagr",
             a."Nome"
      FROM "TPrimaNota" p
      LEFT JOIN "TAnagrafica" a ON a."IDAnagr" = p."IDAnagr"
      WHERE p."Saldato" = 0
        AND p."Importo" < 0
        AND (p."CategPagamento" IS NULL OR p."CategPagamento" <> 'Riba')
        AND LOWER(a."Nome") LIKE '%allis electric%'
      ORDER BY p."DataScad" ASC
    `);
    const data = loadData();
    if (!data.allis_scadenze) data.allis_scadenze = [];
    const wiseSaldati  = data.wise_saldati  || {};
    const wiseSpostate = data.wise_spostate || {};
    let aggiunte = 0;
    rows.forEach(r => {
      if (wiseSaldati[String(r.idprimanota)]) return;
      const scadenza = isoDate(r.datascad);
      const importo  = Math.round(Math.abs(Number(r.importo) || 0) * 100) / 100;
      const rif      = (r.rifpagam || '').trim();
      // Evita duplicati: stessa scadenza e stesso importo (arrotondato a euro)
      const exists = data.allis_scadenze.some(v =>
        v.scadenza === scadenza && Math.round(v.importo) === Math.round(importo)
      );
      if (exists) return;
      data.allis_scadenze.push({
        id: 'ALLIS_' + Date.now() + '_' + aggiunte,
        scadenza, importo, rif, pagato: false,
        creato_il: new Date().toISOString()
      });
      aggiunte++;
    });
    data.allis_scadenze.sort((a, b) => (a.scadenza || '') < (b.scadenza || '') ? -1 : 1);
    saveData(data);
    res.json({ ok: true, aggiunte, totale: data.allis_scadenze.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/allis-pagamenti', (req, res) => {
  const data = loadData();
  res.json({ voci: data.allis_scadenze || [] });
});

app.post('/api/allis-pagamenti/add', (req, res) => {
  const { scadenza, importo, rif } = req.body;
  if (!scadenza || !importo) return res.status(400).json({ error: 'scadenza e importo obbligatori' });
  const data = loadData();
  if (!data.allis_scadenze) data.allis_scadenze = [];
  const voce = { id: 'ALLIS_' + Date.now(), scadenza, importo: Number(importo), rif: rif || '', pagato: false, creato_il: new Date().toISOString() };
  data.allis_scadenze.push(voce);
  data.allis_scadenze.sort((a, b) => (a.scadenza || '') < (b.scadenza || '') ? -1 : 1);
  saveData(data);
  res.json({ ok: true, voce });
});

app.post('/api/allis-pagamenti/update', (req, res) => {
  const { id, scadenza, importo, rif, pagato } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  const data = loadData();
  const idx = (data.allis_scadenze || []).findIndex(v => v.id === id);
  if (idx === -1) return res.status(404).json({ error: 'voce non trovata' });
  if (scadenza !== undefined) data.allis_scadenze[idx].scadenza = scadenza;
  if (importo !== undefined) data.allis_scadenze[idx].importo = Number(importo);
  if (rif     !== undefined) data.allis_scadenze[idx].rif     = rif;
  if (pagato  !== undefined) data.allis_scadenze[idx].pagato  = !!pagato;
  data.allis_scadenze.sort((a, b) => (a.scadenza || '') < (b.scadenza || '') ? -1 : 1);
  saveData(data);
  res.json({ ok: true });
});

app.post('/api/allis-pagamenti/delete', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  const data = loadData();
  data.allis_scadenze = (data.allis_scadenze || []).filter(v => v.id !== id);
  saveData(data);
  res.json({ ok: true });
});

// ─── FATTURE SDI: modifica scadenza manuale ───────────────────────────────────
app.post('/api/fatture-sdi/set-scadenza', (req, res) => {
  const { id, scadenza } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  if (scadenza && !/^\d{4}-\d{2}-\d{2}$/.test(scadenza)) return res.status(400).json({ error: 'formato data non valido' });
  const data = loadData();
  if (!data.sdi_scadenze) data.sdi_scadenze = {};
  if (scadenza) data.sdi_scadenze[id] = scadenza;
  else delete data.sdi_scadenze[id];
  saveData(data);
  res.json({ ok: true });
});

/// ─── FATTURE SDI: set/unset flag controllata ─────────────────────────────────
app.post('/api/fatture-sdi/set-controllata', (req, res) => {
  const { id, controllata } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  const data = loadData();
  if (!data.sdi_controllate) data.sdi_controllate = {};
  if (controllata) data.sdi_controllate[id] = { ts: Date.now() };
  else delete data.sdi_controllate[id];
  saveData(data);
  res.json({ ok: true });
});

/// ─── FATTURE SDI: set nota/riferimento ────────────────────────────────────────
app.post('/api/fatture-sdi/set-note', (req, res) => {
  const { id, note } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  const data = loadData();
  if (!data.sdi_note) data.sdi_note = {};
  if (note) data.sdi_note[id] = note;
  else delete data.sdi_note[id];
  saveData(data);
  res.json({ ok: true });
});

// ─── FATTURE SDI: escludi / ripristina ───────────────────────────────────────
app.post('/api/fatture-sdi/escludi', (req, res) => {
  const { id_agyo, ripristina } = req.body;
  if (!id_agyo) return res.status(400).json({ error: 'id_agyo required' });
  const data = loadData();
  if (!data.sdi_escluse) data.sdi_escluse = {};
  if (ripristina) delete data.sdi_escluse[id_agyo];
  else data.sdi_escluse[id_agyo] = new Date().toISOString();
  saveData(data);
  res.json({ ok: true });
});

// ─── FATTURE SDI: set IBAN manuale fornitore ──────────────────────────────────
app.post('/api/fatture-sdi/set-iban', (req, res) => {
  const { cf, iban } = req.body;
  if (!cf) return res.status(400).json({ error: 'cf required' });
  const data = loadData();
  if (!data.sdi_iban_manuali) data.sdi_iban_manuali = {};
  if (iban) data.sdi_iban_manuali[cf] = iban.replace(/\s/g, '').toUpperCase();
  else delete data.sdi_iban_manuali[cf];
  saveData(data);
  res.json({ ok: true });
});

// ─── FATTURE SDI: segna come pagate ──────────────────────────────────────────
app.post('/api/fatture-sdi/segna-pagate', (req, res) => {
  try {
    const { ids, data_pagamento, fatture_dettaglio } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
    const dataPag = (data_pagamento || new Date().toISOString().slice(0,10)).slice(0,10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataPag)) return res.status(400).json({ error: 'formato data non valido' });

    const data = loadData();
    if (!data.sdi_saldati)  data.sdi_saldati  = {};
    if (!data.sdi_storico)  data.sdi_storico  = [];
    const saldatoIl = new Date().toISOString();

    const dett = fatture_dettaglio || [];
    ids.forEach(id => {
      const f = dett.find(x => x.id === id) || {};
      data.sdi_saldati[id] = { data_pagamento: dataPag, saldato_il: saldatoIl, nome: f.nome || '', importo: f.importo || 0, numdoc: f.numdoc || '', data_doc: f.data_doc || null };
    });

    const pagamenti = ids.map(id => { const f = dett.find(x => x.id === id) || {}; return { id, nome: f.nome || '', importo: f.importo || 0, numdoc: f.numdoc || '', data_doc: f.data_doc || null }; });
    const totale = pagamenti.reduce((s, p) => s + (p.importo || 0), 0);
    data.sdi_storico.push({ batch_id: saldatoIl, data_pagamento: dataPag, saldato_il: saldatoIl, pagamenti, totale });
    saveData(data);
    res.json({ ok: true, aggiornati: ids.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── FATTURE SDI: dati XML persistenti ───────────────────────────────────────
app.get('/api/fatture-sdi/xml-data', (req, res) => {
  const data = loadData();
  res.json({ xmlMap: data.fatture_xml || {} });
});

app.post('/api/fatture-sdi/save-xml-data', (req, res) => {
  const { xmlMap } = req.body;
  if (!xmlMap || typeof xmlMap !== 'object') return res.status(400).json({ error: 'xmlMap mancante' });
  const data = loadData();
  // Merge: aggiunge/aggiorna senza cancellare fatture precedenti
  data.fatture_xml = Object.assign(data.fatture_xml || {}, xmlMap);
  saveData(data);
  const count = Object.keys(data.fatture_xml).length;
  console.log(`[XML] Salvate ${count} fatture XML`);
  res.json({ ok: true, count });
});

// ─── FATTURE SDI: estrai XML da P7M ─────────────────────────────────────────
app.post('/api/fatture-sdi/parse-p7m', (req, res) => {
  try {
    const { data: b64 } = req.body;
    if (!b64) return res.status(400).json({ ok:false, error:'Dati mancanti' });
    const buf = Buffer.from(b64, 'base64');
    // Cerca il marker di inizio XML nel binario P7M
    // Trova inizio XML: preferisce <?xml, fallback a qualsiasi <[prefix:]FatturaElettronica
    let startIdx = buf.indexOf(Buffer.from('<?xml'));
    if (startIdx === -1) {
      const m = buf.toString('binary').match(/<[A-Za-z0-9]*:?FatturaElettronica\b/);
      if (m) startIdx = m.index;
    }
    if (startIdx === -1) return res.status(422).json({ ok:false, error:'XML non trovato nel P7M' });
    const xmlPart = buf.slice(startIdx).toString('utf8');
    // Cerca tag chiusura con qualsiasi namespace prefix (es. </ns0:FatturaElettronica>)
    const closeRegex = /<\/([A-Za-z0-9]+:)?FatturaElettronica\s*>/g;
    let lastMatch = null, mm;
    while ((mm = closeRegex.exec(xmlPart)) !== null) lastMatch = mm;
    if (!lastMatch) return res.status(422).json({ ok:false, error:'Tag di chiusura XML non trovato' });
    const endPos = lastMatch.index + lastMatch[0].length;
    res.json({ ok:true, xml: xmlPart.slice(0, endPos) });
  } catch(e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

/// ─── FATTURE SDI: storico pagamenti ──────────────────────────────────────────
app.get('/api/fatture-sdi/storico', (req, res) => {
  const data = loadData();
  const commenti = data.storico_commenti || {};
  res.json({ storico: (data.sdi_storico || []).slice().reverse().map(b => ({...b, commento: commenti[b.batch_id] || ''})) });
});

// ─── STORICO: set commento su batch ──────────────────────────────────────────
app.post('/api/storico/set-commento', (req, res) => {
  const { batch_id, commento } = req.body;
  if (!batch_id) return res.status(400).json({ error: 'batch_id required' });
  const data = loadData();
  if (!data.storico_commenti) data.storico_commenti = {};
  if (commento && commento.trim()) data.storico_commenti[batch_id] = commento.trim();
  else delete data.storico_commenti[batch_id];
  saveData(data);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// ── OZNEROL SRL — Fatture Fornitori (solo tracking, no gestionale) ─────────
// ═══════════════════════════════════════════════════════════════════════════
const OZNEROL_DATA_FILE = path.join(__dirname, 'oznerol_fatture.json');

function ozLoadData() {
  try {
    const d = JSON.parse(fs.readFileSync(OZNEROL_DATA_FILE, 'utf8'));
    if (!d.fatture)       d.fatture       = [];
    if (!d.saldati)       d.saldati       = {};
    if (!d.scadenze)      d.scadenze      = {};
    if (!d.note)          d.note          = {};
    if (!d.controllate)   d.controllate   = {};
    if (!d.iban_manuali)  d.iban_manuali  = {};
    if (!d.storico)       d.storico       = [];
    if (!d.xml_map)       d.xml_map       = {};
    return d;
  } catch {
    return { fatture: [], saldati: {}, scadenze: {}, note: {}, controllate: {}, iban_manuali: {}, storico: [], xml_map: {} };
  }
}
function ozSaveData(d) { fs.writeFileSync(OZNEROL_DATA_FILE, JSON.stringify(d, null, 2)); }

function ozNormStr(s) { return (s || '').toString().trim().toUpperCase().replace(/\s+/g,''); }

function ozBuildId(f) {
  // Chiave univoca: PIVA/CF + numero + data (evita doppioni)
  const key = ozNormStr(f.piva) || ozNormStr(f.cf);
  return 'OZ_' + key + '_' + ozNormStr(f.numdoc) + '_' + (f.data_doc || '');
}

// ─── OZNEROL: GET lista fatture ──────────────────────────────────────────────
app.get('/api/oznerol/fatture', (req, res) => {
  try {
    const d = ozLoadData();
    const oggi = new Date().toISOString().slice(0,10);
    // Applica override (scadenze, note, controllate, saldati, iban manuali)
    const fatture = d.fatture
      .filter(f => !d.saldati[f.id])
      .map(f => {
        const scadOverride = d.scadenze[f.id];
        const keyId = f.piva || f.cf;
        return {
          ...f,
          scadenza:        scadOverride || f.scadenza || null,
          scadenza_manual: !!scadOverride,
          note:            d.note[f.id] || '',
          controllata:     !!d.controllate[f.id],
          iban_manuale:    d.iban_manuali[keyId] || null
        };
      });
    const totale = fatture.reduce((s,f) => s + (parseFloat(f.importo)||0), 0);
    res.json({ fatture, totale, xml_map: d.xml_map || {} });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── OZNEROL: UPLOAD fatture (client-parsed) ────────────────────────────────
app.post('/api/oznerol/upload', (req, res) => {
  try {
    const { fatture, xml_map } = req.body || {};
    if (!Array.isArray(fatture)) return res.status(400).json({ error: 'fatture array required' });

    const d = ozLoadData();
    const existingIds = new Set(d.fatture.map(f => f.id));
    let importate = 0, scartate = 0;

    fatture.forEach(nf => {
      const numdoc = (nf.numdoc || '').trim();
      const dataDoc = (nf.data_doc || '').slice(0,10);
      const importo = parseFloat(nf.importo) || 0;
      if (!numdoc || !dataDoc) { scartate++; return; }
      const id = ozBuildId(nf);
      if (existingIds.has(id)) { scartate++; return; }
      d.fatture.push({
        id,
        piva:     (nf.piva || '').trim(),
        cf:       (nf.cf || '').trim(),
        nome:     (nf.nome || '').trim(),
        numdoc,
        data_doc: dataDoc,
        importo,
        scadenza: nf.scadenza ? nf.scadenza.slice(0,10) : null,
        iban:     (nf.iban || '').replace(/\s/g,'').toUpperCase() || null,
        idPaese:  (nf.idPaese || 'IT').toUpperCase(),
        rata_n:   nf.rata_n || null,
        source_file: nf.source_file || '',
        imported_at: new Date().toISOString()
      });
      existingIds.add(id);
      importate++;
    });

    // Merge XML map
    if (xml_map && typeof xml_map === 'object') {
      d.xml_map = Object.assign(d.xml_map || {}, xml_map);
    }

    // Ordina per data_doc DESC
    d.fatture.sort((a,b) => (b.data_doc || '').localeCompare(a.data_doc || ''));
    ozSaveData(d);
    res.json({ ok: true, importate, scartate, totale: d.fatture.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── OZNEROL: set scadenza manuale ───────────────────────────────────────────
app.post('/api/oznerol/set-scadenza', (req, res) => {
  const { id, scadenza } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  if (scadenza && !/^\d{4}-\d{2}-\d{2}$/.test(scadenza)) return res.status(400).json({ error: 'formato data non valido' });
  const d = ozLoadData();
  if (scadenza) d.scadenze[id] = scadenza;
  else delete d.scadenze[id];
  ozSaveData(d);
  res.json({ ok: true });
});

// ─── OZNEROL: set nota ──────────────────────────────────────────────────────
app.post('/api/oznerol/set-note', (req, res) => {
  const { id, note } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  const d = ozLoadData();
  if (note) d.note[id] = note;
  else delete d.note[id];
  ozSaveData(d);
  res.json({ ok: true });
});

// ─── OZNEROL: set IBAN manuale per fornitore (per piva/cf) ──────────────────
app.post('/api/oznerol/set-iban', (req, res) => {
  const { key, iban } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  const d = ozLoadData();
  if (iban) d.iban_manuali[key] = iban.replace(/\s/g,'').toUpperCase();
  else delete d.iban_manuali[key];
  ozSaveData(d);
  res.json({ ok: true });
});

// ─── OZNEROL: set flag controllata ──────────────────────────────────────────
app.post('/api/oznerol/set-controllata', (req, res) => {
  const { id, controllata } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  const d = ozLoadData();
  if (controllata) d.controllate[id] = { ts: Date.now() };
  else delete d.controllate[id];
  ozSaveData(d);
  res.json({ ok: true });
});

// ─── OZNEROL: segna come pagate (batch) ─────────────────────────────────────
app.post('/api/oznerol/segna-pagate', (req, res) => {
  try {
    const { ids, data_pagamento, fatture_dettaglio } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
    const dataPag = (data_pagamento || new Date().toISOString().slice(0,10)).slice(0,10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataPag)) return res.status(400).json({ error: 'formato data non valido' });

    const d = ozLoadData();
    const saldatoIl = new Date().toISOString();
    const dett = fatture_dettaglio || [];
    ids.forEach(id => {
      const f = dett.find(x => x.id === id) || d.fatture.find(x => x.id === id) || {};
      d.saldati[id] = { data_pagamento: dataPag, saldato_il: saldatoIl, nome: f.nome || '', importo: f.importo || 0, numdoc: f.numdoc || '', data_doc: f.data_doc || null };
    });

    const pagamenti = ids.map(id => { const f = dett.find(x => x.id === id) || d.fatture.find(x => x.id === id) || {}; return { id, nome: f.nome || '', importo: f.importo || 0, numdoc: f.numdoc || '', data_doc: f.data_doc || null }; });
    const totale = pagamenti.reduce((s, p) => s + (parseFloat(p.importo) || 0), 0);
    d.storico.push({ batch_id: saldatoIl, data_pagamento: dataPag, saldato_il: saldatoIl, pagamenti, totale });
    ozSaveData(d);
    res.json({ ok: true, aggiornati: ids.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── OZNEROL: storico pagamenti ─────────────────────────────────────────────
app.get('/api/oznerol/storico', (req, res) => {
  const d = ozLoadData();
  res.json({ storico: (d.storico || []).slice().reverse() });
});

// ─── OZNEROL: ripristina saldato (rimette la fattura in lista da pagare) ───
app.delete('/api/oznerol/saldato/:id', (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'id required' });
    const d = ozLoadData();
    const era = !!d.saldati[id];
    delete d.saldati[id];
    // Rimuovi la fattura anche da eventuali batch dello storico; scarta i batch rimasti vuoti
    if (Array.isArray(d.storico)) {
      d.storico = d.storico
        .map(b => {
          const pag = (b.pagamenti || []).filter(p => p.id !== id);
          const rimosse = (b.pagamenti || []).length - pag.length;
          if (!rimosse) return b;
          const nuovoTot = pag.reduce((s, p) => s + (parseFloat(p.importo) || 0), 0);
          return Object.assign({}, b, { pagamenti: pag, totale: nuovoTot });
        })
        .filter(b => (b.pagamenti || []).length > 0);
    }
    ozSaveData(d);
    res.json({ ok: true, era_saldata: era });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── OZNEROL: elimina fattura (hard delete) ─────────────────────────────────
app.delete('/api/oznerol/fattura/:id', (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'id required' });
  const d = ozLoadData();
  d.fatture = d.fatture.filter(f => f.id !== id);
  delete d.scadenze[id];
  delete d.note[id];
  delete d.controllate[id];
  delete d.saldati[id];
  ozSaveData(d);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// ── EBIT/EBITDA SNAPSHOTS — persistenza bilanci trimestrali ────────────────
// ═══════════════════════════════════════════════════════════════════════════
const EBIT_DATA_FILE = path.join(__dirname, 'ebit_snapshots.json');

function ebitLoadData() {
  try {
    const d = JSON.parse(fs.readFileSync(EBIT_DATA_FILE, 'utf8'));
    if (!d.snapshots || typeof d.snapshots !== 'object') d.snapshots = {};
    return d;
  } catch {
    return { snapshots: {} };
  }
}
function ebitSaveData(d) { fs.writeFileSync(EBIT_DATA_FILE, JSON.stringify(d, null, 2)); }

// ─── EBIT: GET lista snapshot ────────────────────────────────────────────────
app.get('/api/ebit/snapshots', (req, res) => {
  try {
    const d = ebitLoadData();
    const list = Object.values(d.snapshots)
      .map(s => ({
        id: s.id,
        date: s.date,
        previousDate: s.previousDate,
        companyName: s.companyName,
        filename: s.filename,
        uploadedAt: s.uploadedAt,
        calculated: s.calculated
      }))
      .sort((a,b) => (b.date||'').localeCompare(a.date||''));
    res.json({ snapshots: list });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── EBIT: GET singolo snapshot ──────────────────────────────────────────────
app.get('/api/ebit/snapshots/:id', (req, res) => {
  try {
    const d = ebitLoadData();
    const s = d.snapshots[req.params.id];
    if (!s) return res.status(404).json({ error: 'snapshot not found' });
    res.json(s);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── EBIT: POST salva snapshot ───────────────────────────────────────────────
app.post('/api/ebit/snapshots', (req, res) => {
  try {
    const snap = req.body;
    if (!snap || !snap.date) return res.status(400).json({ error: 'date required' });
    const id = snap.id || snap.date;
    const d = ebitLoadData();
    d.snapshots[id] = Object.assign({}, snap, {
      id,
      uploadedAt: new Date().toISOString()
    });
    ebitSaveData(d);
    res.json({ ok: true, id, overwrite: !!d.snapshots[id] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── EBIT: DELETE snapshot ───────────────────────────────────────────────────
app.delete('/api/ebit/snapshots/:id', (req, res) => {
  try {
    const d = ebitLoadData();
    const existed = !!d.snapshots[req.params.id];
    delete d.snapshots[req.params.id];
    ebitSaveData(d);
    res.json({ ok: true, existed });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SAVE SALDO INIZIALE CASHFLOW ─────────────────────────
app.post('/api/saldo', (req, res) => {
  const data = loadData();
  data.saldo_iniziale = Number(req.body.saldo) || 0;
  saveData(data);
  res.json({ ok: true, saldo_iniziale: data.saldo_iniziale });
});

// ─── GET SALDI BANCHE ─────────────────────────────────────
app.get('/api/saldi-banche', (req, res) => {
  const data = loadData();
  res.json(data.saldi_banche);
});

// ─── SAVE SALDI BANCHE ────────────────────────────────────
app.post('/api/saldi-banche', (req, res) => {
  const data = loadData();
  const { banche } = req.body;
  if (!Array.isArray(banche)) return res.status(400).json({ error: 'banche array required' });

  // Merge: update saldo/vincoli per id, keep other fields
  banche.forEach(b => {
    const existing = data.saldi_banche.banche.find(x => x.id === b.id);
    if (existing) {
      existing.saldo = Number(b.saldo) || 0;
      if (existing.vincoli !== undefined) existing.vincoli = Number(b.vincoli) || 0;
    }
  });
  data.saldi_banche.aggiornato_il = new Date().toISOString();
  saveData(data);
  res.json({ ok: true, aggiornato_il: data.saldi_banche.aggiornato_il });
});

// ─── SAVE VOCE MANUALE ────────────────────────────────────
app.post('/api/voce', (req, res) => {
  const data = loadData();
  const voce = {
    id: Date.now(),
    tipo: req.body.tipo,
    descrizione: req.body.descrizione || '',
    importo: Math.abs(Number(req.body.importo) || 0),
    data_scad: req.body.data_scad,
    data_fmt: req.body.data_scad ? req.body.data_scad.split('-').reverse().join('/') : null
  };
  data.voci_manuali = data.voci_manuali || [];
  data.voci_manuali.push(voce);
  saveData(data);
  res.json({ ok: true, voce });
});

// ─── DELETE VOCE MANUALE ──────────────────────────────────
app.delete('/api/voce/:id', (req, res) => {
  const data = loadData();
  data.voci_manuali = (data.voci_manuali || []).filter(v => v.id !== Number(req.params.id));
  saveData(data);
  res.json({ ok: true });
});


// ─── F24 TELEMATICO ──────────────────────────────────────────────────────────

function f24an(v,l){return String(v||'').toUpperCase().slice(0,l).padEnd(l);}
function f24nu(v,l){let n=0;try{n=Math.abs(parseInt(String(v||'0').trim())||0);}catch(e){}return String(n).padStart(l,'0').slice(-l);}
function f24euro(s){s=String(s||'').trim();if(!s)return 0;return parseInt(s.replace(/\./g,'').replace(',',''))||0;}
function f24c15(c){return String(Math.abs(Math.round(c))).padStart(15,'0').slice(-15);}
function f24itfmt(c){const n=Math.abs(Math.round(c)),e=Math.floor(n/100),d=n%100;return e.toLocaleString('it-IT')+','+String(d).padStart(2,'0');}
function f24tot(dc){const td=dc.reduce((s,[d])=>s+d,0),tc=dc.reduce((s,[,c])=>s+c,0),sa=td-tc;return[td,tc,(td===0&&tc===0)?' ':(sa>=0?'P':'N'),Math.abs(sa)];}
function f24w(b,p,t){for(let i=0;i<t.length;i++)b[p+i]=t[i];}
function f24end(b){return b.join('')+'A\r\n';}

function genRecordA(c){
  const b=Array(1897).fill(' ');b[0]='A';
  f24w(b,15,f24an('F24A0',5));f24w(b,20,f24an('14',2));f24w(b,22,f24an(c.cf,16));
  f24w(b,83,f24nu(0,8));f24w(b,210,f24nu(0,5));
  f24w(b,215,f24an(c.denominazione,60));f24w(b,275,f24an(c.comune,40));
  f24w(b,315,f24an(c.prov,2));f24w(b,317,f24an(c.indirizzo,35));f24w(b,352,f24nu(c.cap,5));
  f24w(b,357,f24an(c.comune,40));f24w(b,397,f24an(c.prov,2));f24w(b,399,f24an(c.indirizzo,35));f24w(b,434,f24nu(c.cap,5));
  f24w(b,521,f24nu(1,3));f24w(b,524,f24nu(1,3));
  return f24end(b);
}

function genRecordM(c,saldo){
  const b=Array(1897).fill(' ');b[0]='M';
  f24w(b,1,f24an(c.cf,16));f24w(b,17,f24nu(1,8));
  b[90]='E';b[91]='0';b[92]='0';b[109]='0';
  f24w(b,155,f24nu(0,8));f24w(b,247,f24nu(0,5));
  f24w(b,287,f24an(c.comune,40));f24w(b,327,f24an(c.prov,2));
  f24w(b,329,f24nu(c.cap,5));f24w(b,334,f24an(c.indirizzo,35));
  f24w(b,481,f24nu(0,8));f24w(b,517,f24an(c.denominazione,55));
  f24w(b,1868,f24an('EURO',4));f24w(b,1872,f24an(f24itfmt(saldo),15));
  const dv=c.dataVersamento;
  f24w(b,1887,f24an(dv.slice(0,2)+'-'+dv.slice(2,4)+'-'+dv.slice(4,8),10));
  return f24end(b);
}

function genRecordV(c){
  const b=Array(1897).fill(' ');b[0]='V';
  f24w(b,1,f24an(c.cf,16));f24w(b,17,f24nu(1,8));b[89]='A';f24w(b,93,f24nu(0,11));
  // ERARIO
  const PE=[104,162,220,278,336,394];const eDc=[];
  for(let i=0;i<6;i++){const p=PE[i];let dC=0,cC=0;
    if(i<(c.erario||[]).length){const[ct,nr,an,ds,cs]=c.erario[i];dC=f24euro(ds);cC=f24euro(cs);
      f24w(b,p,f24an(ct,4));f24w(b,p+4,f24an('',16));f24w(b,p+20,f24an(nr,4));f24w(b,p+24,f24an(an,4));f24w(b,p+28,f24c15(dC));f24w(b,p+43,f24c15(cC));
    }else{f24w(b,p+24,f24nu(0,4));f24w(b,p+28,f24c15(0));f24w(b,p+43,f24c15(0));}
    eDc.push([dC,cC]);}
  const[etd,etc,es,esa]=f24tot(eDc);f24w(b,452,f24c15(etd));f24w(b,467,f24c15(etc));b[482]=es;f24w(b,483,f24c15(esa));
  // INPS
  const PI=[498,565,632,699];const iDc=[];
  for(let i=0;i<4;i++){const p=PI[i];let dC=0,cC=0;
    if(i<(c.inps||[]).length){const[sd,ca,ma,pd,pa,ds,cs]=c.inps[i];dC=f24euro(ds);cC=f24euro(cs);
      f24w(b,p,f24an(sd,4));f24w(b,p+4,f24an(ca,4));f24w(b,p+8,f24an(ma,17));f24w(b,p+25,f24an(pd,6));f24w(b,p+31,'000000');f24w(b,p+37,f24c15(dC));f24w(b,p+52,f24c15(cC));
    }else{f24w(b,p,f24nu(0,4));f24w(b,p+25,f24nu(0,6));f24w(b,p+31,f24nu(0,6));f24w(b,p+37,f24c15(0));f24w(b,p+52,f24c15(0));}
    iDc.push([dC,cC]);}
  const[itd,itc,is,isa]=f24tot(iDc);f24w(b,766,f24c15(itd));f24w(b,781,f24c15(itc));b[796]=is;f24w(b,797,f24c15(isa));
  // REGIONI
  const PR=[812,856,900,944];const rDc=[];
  for(let i=0;i<4;i++){const p=PR[i];let dC=0,cC=0,act=false;
    if(i<(c.regioni||[]).length){const[cr,tr,rz,an,ds,cs]=c.regioni[i];dC=f24euro(ds);cC=f24euro(cs);
      if(dC||cC){act=true;f24w(b,p,f24an(cr,2));f24w(b,p+2,f24an(tr,4));f24w(b,p+6,f24an(rz,4));f24w(b,p+10,f24an(an,4));f24w(b,p+14,f24c15(dC));f24w(b,p+29,f24c15(cC));}}
    if(!act){dC=cC=0;f24w(b,p,f24nu(0,2));f24w(b,p+10,f24nu(0,4));f24w(b,p+14,f24c15(0));f24w(b,p+29,f24c15(0));}
    rDc.push([dC,cC]);}
  const[rtd,rtc,rs,rsa]=f24tot(rDc);f24w(b,988,f24c15(rtd));f24w(b,1003,f24c15(rtc));b[1018]=rs;f24w(b,1019,f24c15(rsa));
  // IMU
  const PIM=[1052,1120,1188,1256];const mDc=[];
  for(let i=0;i<4;i++){const p=PIM[i];let dC=0,cC=0;
    if(i<(c.imu||[]).length){const[cc,ni,ac,sf,iv,ae,dt,ct,nr,an,ds,cs]=c.imu[i];dC=f24euro(ds);cC=f24euro(cs);const dtC=f24euro(dt);
      f24w(b,p,f24an(cc,4));b[p+4]=String(ae||'0')[0];b[p+5]=String(iv||'0')[0];b[p+6]=String(ac||'0')[0];b[p+7]=String(sf||'0')[0];
      f24w(b,p+8,f24nu(ni,3));f24w(b,p+11,f24c15(dtC));f24w(b,p+26,f24an(ct,4));f24w(b,p+30,f24an(nr,4));f24w(b,p+34,f24an(an,4));f24w(b,p+38,f24c15(dC));f24w(b,p+53,f24c15(cC));
    }else{b[p+4]='0';b[p+5]='0';b[p+6]='0';b[p+7]='0';f24w(b,p+8,f24nu(0,3));f24w(b,p+11,f24c15(0));f24w(b,p+34,f24nu(0,4));f24w(b,p+38,f24c15(0));f24w(b,p+53,f24c15(0));}
    mDc.push([dC,cC]);}
  const[mtd,mtc,ms,msa]=f24tot(mDc);f24w(b,1324,f24c15(mtd));f24w(b,1339,f24c15(mtc));b[1354]=ms;f24w(b,1355,f24c15(msa));
  // INAIL zero-fill
  for(const p of[1370,1422,1474]){f24w(b,p,f24nu(0,5));f24w(b,p+5,f24nu(0,8));f24w(b,p+13,f24nu(0,2));f24w(b,p+15,f24nu(0,6));f24w(b,p+22,f24c15(0));f24w(b,p+37,f24c15(0));}
  f24w(b,1526,f24c15(0));f24w(b,1541,f24c15(0));b[1556]=' ';f24w(b,1557,f24c15(0));
  // ALTRI ENTI zero-fill
  f24w(b,1572,f24nu(0,4));
  for(const p of[1576,1636]){f24w(b,p+9,f24nu(0,9));f24w(b,p+18,f24nu(0,6));f24w(b,p+24,f24nu(0,6));f24w(b,p+30,f24c15(0));f24w(b,p+45,f24c15(0));}
  f24w(b,1696,f24c15(0));f24w(b,1711,f24c15(0));b[1726]=' ';f24w(b,1727,f24c15(0));
  // Saldo finale
  const allDc=[...eDc,...iDc,...rDc,...mDc];
  const allDeb=allDc.reduce((s,[d])=>s+d,0),allCred=allDc.reduce((s,[,c])=>s+c,0);
  f24w(b,1792,f24c15(Math.abs(allDeb-allCred)));f24w(b,1807,f24an(c.dataVersamento,8));
  return[f24end(b),allDeb-allCred];
}

function genRecordZ(nV,nM){const b=Array(1897).fill(' ');b[0]='Z';f24w(b,15,f24nu(nV,9));f24w(b,24,f24nu(nM,9));return f24end(b);}

const F24_FIXED={cf:'12520320156',denominazione:'AEC INTERNATIONAL S.R.L.',comune:'LAINATE',prov:'MI',indirizzo:'VIA NERVIANO 55',cap:'20020'};

app.post('/api/f24/genera-txt',(req,res)=>{
  try{
    const cfg={...F24_FIXED,...req.body};
    const[vData,saldoNetto]=genRecordV(cfg);
    const content=genRecordA(cfg)+genRecordM(cfg,Math.abs(saldoNetto))+vData+genRecordZ(1,1);
    const dv=cfg.dataVersamento||'00000000';
    const fname=`F24_${dv.slice(4,8)}${dv.slice(2,4)}${dv.slice(0,2)}.txt`;
    res.setHeader('Content-Type','text/plain; charset=ascii');
    res.setHeader('Content-Disposition',`attachment; filename="${fname}"`);
    res.send(content);
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

// ─── F24 OCR (Claude Vision) ──────────────────────────────────────────────────

app.post('/api/f24/ocr-page', async (req, res) => {
  try {
    let Anthropic;
    try { Anthropic = require('@anthropic-ai/sdk'); }
    catch(e) { return res.status(503).json({ ok:false, error:'SDK Anthropic non installato. Esegui: npm install @anthropic-ai/sdk' }); }

    try { require('dotenv').config(); } catch(e) {}
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(503).json({ ok:false, error:'ANTHROPIC_API_KEY non configurata nel file .env del server' });
    const client = new Anthropic({ apiKey });

    const { image_base64 } = req.body;
    if (!image_base64) return res.status(400).json({ ok:false, error:'Nessuna immagine fornita' });
    const match = image_base64.match(/^data:(image\/[\w+]+);base64,(.+)$/);
    if (!match) return res.status(400).json({ ok:false, error:'Formato immagine non valido' });

    console.log('[F24-OCR] Invio pagina a Claude Vision...');
    const timeoutPromise = new Promise((_,reject) =>
      setTimeout(() => reject(new Error('Timeout OCR dopo 90 secondi')), 90000)
    );

    const response = await Promise.race([timeoutPromise, client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type:'image', source:{ type:'base64', media_type:match[1], data:match[2] } },
          { type:'text', text:`Analizza questa immagine di un modulo F24 italiano (generato da software gestionale come Zucchetti).

Estrai TUTTI i dati compilati e rispondi ESCLUSIVAMENTE in formato JSON valido:

{
  "dataVersamento": "data in formato DDMMAAAA es. 16042026, null se non presente",
  "erario": [
    ["codTributo", "rateazione", "annoRif", "importoDebiti", "importoCrediti"]
  ],
  "inps": [
    ["sede", "causale", "matricola", "periodoDa", "periodoA", "importoDebiti", "importoCrediti"]
  ],
  "regioni": [
    ["codRegione", "codTributo", "rateazione", "annoRif", "importoDebiti", "importoCrediti"]
  ],
  "imu": [
    ["codComune", "numImmobili", "flagAcconto", "flagSaldo", "flagVariazione", "flagAE", "detrazione", "codTributo", "rateazione", "annoRif", "importoDebiti", "importoCrediti"]
  ]
}

REGOLE:
- Includi SOLO righe con dati compilati, non righe vuote
- importoDebiti/Crediti: stringa formato italiano es. "1.234,56" oppure "" se zero/vuoto
- rateazione: stringa es. "0101" oppure "" se vuota
- flagAcconto/Saldo/Variazione/AE (solo IMU): "1" se casella barrata, "0" altrimenti
- numImmobili (IMU): stringa numerica intera es. "1"
- detrazione (IMU): importo es. "200,00" oppure "0,00"
- codComune (IMU): 4 caratteri alfanumerici es. "A652"
- Se una sezione non ha righe compilate: array vuoto []
- Rispondi SOLO con il JSON, zero markdown, zero commenti` }
        ]
      }]
    })]);

    const text = response.content[0].text.trim();
    console.log('[F24-OCR] Risposta Claude:', text.substring(0,300));
    const jsonStr = text.replace(/^```json?\s*/i,'').replace(/\s*```$/i,'').trim();
    let data;
    try { data = JSON.parse(jsonStr); }
    catch(e) { return res.status(422).json({ ok:false, error:'Errore parsing risposta Claude', raw:text }); }

    data.erario  = data.erario  || [];
    data.inps    = data.inps    || [];
    data.regioni = data.regioni || [];
    data.imu     = data.imu     || [];
    if (!data.dataVersamento) data.dataVersamento = '';

    console.log(`[F24-OCR] erario=${data.erario.length} inps=${data.inps.length} regioni=${data.regioni.length} imu=${data.imu.length}`);
    res.json({ ok:true, data });

  } catch(e) {
    console.error('[F24-OCR] Errore:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ─── DIAGNOSTICA: DOPPIONI TAgyo vs TDocTestate ─────────────────────────────
// Trova fatture presenti SIA in TAgyo (Fatture da Pagare) SIA in TDocTestate (Pagamenti Fornitori)
// Matching su CF/PIVA + NumDoc normalizzato
app.get('/api/fatture-sdi/debug-doppioni', async (req, res) => {
  try {
    const norm = (s) => (s || '').toString().trim().toUpperCase().replace(/\s+/g, '');
    // TAgyo: fatture SDI dal 01/04/2026
    const agyoRows = await query(`SELECT * FROM "TAgyo" WHERE "Acq" = 1`);
    const cutoff = new Date('2026-04-01');
    const agyoFilter = agyoRows.filter(r => r.dataricezione && new Date(r.dataricezione) >= cutoff);

    // TDocTestate: tutte le fatture (uso SELECT * per evitare problemi con case dei nomi colonna)
    const docRows = await query(`SELECT * FROM "TDocTestate"`);
    // TAnagrafica: per ricavare CF/PIVA del fornitore associato a IDAnagr
    const anaRows = await query(`SELECT * FROM "TAnagrafica"`);
    const anaByIdAnagr = {};
    anaRows.forEach(a => {
      // Cerca campi CF e PIVA in modo tollerante (Firebird può usare nomi diversi)
      const cf = a.codicefiscale || a.codice_fiscale || a.cf || '';
      const piva = a.partitaiva || a.partita_iva || a.partiva || a.piva || '';
      anaByIdAnagr[a.idanagr] = { cf, piva, nome: a.nome || '' };
    });

    // Indicizza TDocTestate per chiave (cf|piva, numdoc)
    const docIdx = {};
    docRows.forEach(d => {
      const num = norm(d.numdoc);
      if (!num) return;
      const ana = anaByIdAnagr[d.idanagr] || {};
      const cf = norm(ana.cf);
      const piva = norm(ana.piva);
      [cf, piva].filter(Boolean).forEach(k => {
        const key = k + '|' + num;
        if (!docIdx[key]) docIdx[key] = [];
        docIdx[key].push({ iddoc: d.iddoc, numdoc: d.numdoc, datadoc: d.datadoc, idanagr: d.idanagr, totdapagare: d.totdapagare || d.totdoc, nome: ana.nome });
      });
    });

    // Cerca doppioni
    const doppioni = [];
    agyoFilter.forEach(r => {
      const num = norm(r.numdoc);
      if (!num) return;
      const cf = norm(r.codicefiscale);
      const piva = norm(r.partitaiva);
      const keys = [cf, piva].filter(Boolean).map(k => k + '|' + num);
      for (const key of keys) {
        if (docIdx[key] && docIdx[key].length) {
          doppioni.push({
            agyo: { idagyo: r.idagyo, nome: r.nome, numdoc: r.numdoc, datadoc: r.datadoc, importo: r.totdovuto, cf: r.codicefiscale, piva: r.partitaiva, dataricezione: r.dataricezione },
            danea: docIdx[key]
          });
          break;
        }
      }
    });

    res.json({
      agyo_count: agyoFilter.length,
      docs_count: docRows.length,
      doppioni_count: doppioni.length,
      doppioni
    });
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// ─── CHECKLIST MENSILE + TRIMESTRALE ─────────────────────────────────────────
// Struttura dati:
//   data.checklist       = { items: [{ id, titolo, createdAt }], stato: { "YYYY-MM": { itemId: { ts } } } }
//   data.checklist_trim  = { items: [...], stato: { "YYYY-QN": { itemId: { ts } } } }

const _CHK_STORES = {
  mensile:     { key: 'checklist',      periodoRegex: /^\d{4}-\d{2}$/,     periodoMsg: 'YYYY-MM' },
  trimestrale: { key: 'checklist_trim', periodoRegex: /^\d{4}-Q[1-4]$/,    periodoMsg: 'YYYY-QN' }
};

function _chkLoadStore(tipo) {
  const st = _CHK_STORES[tipo];
  const data = loadData();
  if (!data[st.key]) data[st.key] = { items: [], stato: {} };
  if (!Array.isArray(data[st.key].items)) data[st.key].items = [];
  if (!data[st.key].stato || typeof data[st.key].stato !== 'object') data[st.key].stato = {};
  return data;
}

// Factory: registra 6 endpoint (GET, POST item, PUT item, DELETE item, POST stato, POST move) per un tipo
function _chkRegisterEndpoints(basePath, tipo) {
  const st = _CHK_STORES[tipo];
  const key = st.key;

  app.get(basePath, (req, res) => {
    const data = _chkLoadStore(tipo);
    res.json(data[key]);
  });

  app.post(basePath + '/item', (req, res) => {
    const { titolo } = req.body || {};
    if (!titolo || !titolo.trim()) return res.status(400).json({ error: 'titolo required' });
    const data = _chkLoadStore(tipo);
    const id = 'chk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    data[key].items.push({ id, titolo: titolo.trim(), createdAt: Date.now() });
    saveData(data);
    res.json(data[key]);
  });

  app.put(basePath + '/item', (req, res) => {
    const { id, titolo } = req.body || {};
    if (!id || !titolo || !titolo.trim()) return res.status(400).json({ error: 'id e titolo required' });
    const data = _chkLoadStore(tipo);
    const it = data[key].items.find(x => x.id === id);
    if (!it) return res.status(404).json({ error: 'item not found' });
    it.titolo = titolo.trim();
    saveData(data);
    res.json(data[key]);
  });

  app.delete(basePath + '/item', (req, res) => {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const data = _chkLoadStore(tipo);
    data[key].items = data[key].items.filter(x => x.id !== id);
    saveData(data);
    res.json(data[key]);
  });

  // Accetta sia { periodo } (nuovo) che { mese } (legacy per compatibilità)
  app.post(basePath + '/stato', (req, res) => {
    const body = req.body || {};
    const periodo = body.periodo || body.mese;
    const { id, fatta } = body;
    if (!id || !periodo) return res.status(400).json({ error: 'id e periodo required' });
    if (!st.periodoRegex.test(periodo)) return res.status(400).json({ error: 'periodo formato ' + st.periodoMsg });
    const data = _chkLoadStore(tipo);
    if (!data[key].stato[periodo]) data[key].stato[periodo] = {};
    if (fatta) data[key].stato[periodo][id] = { ts: Date.now() };
    else delete data[key].stato[periodo][id];
    saveData(data);
    res.json(data[key]);
  });

  // Sposta item su/giù nell'array items
  app.post(basePath + '/item/move', (req, res) => {
    const { id, direction } = req.body || {};
    if (!id || (direction !== 'up' && direction !== 'down')) return res.status(400).json({ error: 'id e direction (up|down) required' });
    const data = _chkLoadStore(tipo);
    const arr = data[key].items;
    const idx = arr.findIndex(x => x.id === id);
    if (idx < 0) return res.status(404).json({ error: 'item not found' });
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= arr.length) return res.json(data[key]); // già al limite, no-op
    const [moved] = arr.splice(idx, 1);
    arr.splice(newIdx, 0, moved);
    saveData(data);
    res.json(data[key]);
  });
}

_chkRegisterEndpoints('/api/checklist',      'mensile');
_chkRegisterEndpoints('/api/checklist-trim', 'trimestrale');

// ═════════════════════════════════════════════════════════════════════════════
// ─── PARTITARI CONTABILITÀ (CSV importati dal commercialista) ───────────────
// ═════════════════════════════════════════════════════════════════════════════
const PARTITARI_DIR = path.join(__dirname, 'partitari');
if (!fs.existsSync(PARTITARI_DIR)) fs.mkdirSync(PARTITARI_DIR, { recursive: true });

// Cache: snapshot (es. "20260331") → dati parsati
const _partitariCache = {};

function _partNum(s) {
  if (s == null || s === '') return 0;
  const n = String(s).trim().replace(/\./g, '').replace(',', '.');
  const v = parseFloat(n);
  return isNaN(v) ? 0 : v;
}

function _partDate(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// Parser CSV semplice per separatore ';' (formato Zucchetti/Nuova Informatica)
// Il file in esame NON usa quoting: basta split su ';'. Gestisco comunque il quoting "..."
function _parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i+1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ';') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parsePartitariCsv(filePath) {
  const txt = fs.readFileSync(filePath, 'utf8');
  const lines = txt.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length < 2) return { header: {}, sottoconti: {} };

  // Header columns (indici che ci servono)
  const H = _parseCsvLine(lines[0]);
  const idx = name => H.findIndex(h => h.trim().toUpperCase() === name.toUpperCase());

  const I = {
    sogg:        idx('DENOMINAZIONE'),
    esercizio:   idx('ESERCIZIO'),
    inizio:      idx('INIZIO ESERCIZIO'),
    fine:        idx('FINE ESERCIZIO'),
    // Riga "saldo esercizio precedente"
    sc_prec:     idx('S/C SALDO ES. PREC'),
    descr_prec:  idx('DESCR. S/C SALDO ES. PREC.'),
    cf_prec:     idx('CLI/FOR SALDO ES. PREC'),
    codcf_prec:  idx('COD. CLI/FOR SALDO ES. PREC.'),
    sez_prec:    idx('SEZ.SALDO ES. PREC.'),
    sald_prec:   idx('SALDO ES.PREC.'),
    tipo_prec:   idx('TIPO SALDO ES.PREC.'),
    // Riga movimento
    sc:          idx('SOTTOCONTO'),
    codcf:       idx('COD.CLI/FOR'),
    descr_sc:    idx('DESCRIZ. S/C'),
    descr_cf:    idx('DESCR. CLI/FOR'),
    cf:          idx('CODICE FISCALE'),
    piva:        idx('PARTITA IVA'),
    data_reg:    idx('DATA REGISTRAZIONE'),
    prot:        idx('PROT.'),
    data_doc:    idx('DATA DOCUMENTO'),
    nr_doc:      idx('NR.DOC.'),
    sez:         idx('SEZ.SALDO'),
    saldo:       idx('SALDO'),
    dare:        idx('DARE'),
    avere:       idx('AVERE'),
    contro:      idx('CONTROPARTITA'),
    diversi:     idx('DIVERSI'),
    descr:       idx('DESCRIZIONE'),
    descr_riga:  idx('DESCRIZIONE RIGA')
  };

  const sottoconti = {};     // key: code → { code, nome, has_cli_for, saldo_iniziale, totali, movimenti:[], cli_for:{} }
  let soggetto = null, esercizio = null, inizio = null, fine = null;

  function getOrCreateSottoconto(code, nome) {
    if (!sottoconti[code]) {
      sottoconti[code] = {
        codice: code,
        descrizione: nome || '',
        has_cli_for: false,
        saldo_iniziale: null,
        totali: { dare: 0, avere: 0 },
        movimenti: [],
        cli_for: {}
      };
    } else if (nome && !sottoconti[code].descrizione) {
      sottoconti[code].descrizione = nome;
    }
    return sottoconti[code];
  }

  function getOrCreateCliFor(sc, codcf, descrcf, cf, piva) {
    sc.has_cli_for = true;
    if (!sc.cli_for[codcf]) {
      sc.cli_for[codcf] = {
        codice: codcf,
        descrizione: descrcf || '',
        cf: cf || '',
        piva: piva || '',
        saldo_iniziale: null,
        totali: { dare: 0, avere: 0 },
        movimenti: []
      };
    } else {
      const c = sc.cli_for[codcf];
      if (descrcf && !c.descrizione) c.descrizione = descrcf;
      if (cf && !c.cf) c.cf = cf;
      if (piva && !c.piva) c.piva = piva;
    }
    return sc.cli_for[codcf];
  }

  for (let i = 1; i < lines.length; i++) {
    const r = _parseCsvLine(lines[i]);
    if (!soggetto) soggetto = r[I.sogg];
    if (!esercizio) esercizio = r[I.esercizio];
    if (!inizio) inizio = r[I.inizio];
    if (!fine)   fine   = r[I.fine];

    const tipoPrec = (r[I.tipo_prec] || '').trim();
    const scPrec   = (r[I.sc_prec]   || '').trim();
    const scMov    = (r[I.sc]        || '').trim();

    // Riga SALDO ESERCIZIO PRECEDENTE
    if (tipoPrec && scPrec) {
      const sc = getOrCreateSottoconto(scPrec, (r[I.descr_prec]||'').trim());
      const sez = (r[I.sez_prec] || 'D').trim();
      const imp = _partNum(r[I.sald_prec]);
      const codcf = (r[I.codcf_prec] || '').trim();
      const descrcf = (r[I.cf_prec] || '').trim();
      if (codcf || descrcf) {
        const c = getOrCreateCliFor(sc, codcf, descrcf, '', '');
        c.saldo_iniziale = { sez, importo: imp };
      } else {
        sc.saldo_iniziale = { sez, importo: imp };
      }
      continue;
    }

    // Riga movimento
    if (scMov) {
      const sc = getOrCreateSottoconto(scMov, (r[I.descr_sc]||'').trim());
      const codcf = (r[I.codcf] || '').trim();
      const descrcf = (r[I.descr_cf] || '').trim();
      const target = (codcf || descrcf)
        ? getOrCreateCliFor(sc, codcf, descrcf, (r[I.cf]||'').trim(), (r[I.piva]||'').trim())
        : sc;

      const dare  = _partNum(r[I.dare]);
      const avere = _partNum(r[I.avere]);

      const mov = {
        data_reg:   _partDate(r[I.data_reg]),
        protocollo: (r[I.prot] || '').trim(),
        data_doc:   _partDate(r[I.data_doc]),
        nr_doc:     (r[I.nr_doc] || '').trim(),
        sez:        (r[I.sez] || '').trim(),
        saldo:      _partNum(r[I.saldo]),
        dare, avere,
        contropartita: (r[I.contro] || '').trim(),
        diversi:       (r[I.diversi] || '').trim(),
        descrizione:   (r[I.descr] || '').trim(),
        descrizione_riga: (r[I.descr_riga] || '').trim()
      };

      target.movimenti.push(mov);
      target.totali.dare  += dare;
      target.totali.avere += avere;
      if (target !== sc) {
        sc.totali.dare  += dare;
        sc.totali.avere += avere;
      }
    }
  }

  // Calcola saldo finale per ogni sottoconto e cli/for
  for (const code of Object.keys(sottoconti)) {
    const sc = sottoconti[code];
    const si = sc.saldo_iniziale;
    const siSigned = si ? (si.sez === 'D' ? si.importo : -si.importo) : 0;
    sc.totali.saldo_finale = siSigned + sc.totali.dare - sc.totali.avere;
    sc.totali.saldo_iniziale = siSigned;
    for (const codcf of Object.keys(sc.cli_for)) {
      const c = sc.cli_for[codcf];
      const csi = c.saldo_iniziale;
      const csiSigned = csi ? (csi.sez === 'D' ? csi.importo : -csi.importo) : 0;
      c.totali.saldo_finale = csiSigned + c.totali.dare - c.totali.avere;
      c.totali.saldo_iniziale = csiSigned;
    }
  }

  return {
    header: { soggetto, esercizio, inizio, fine },
    sottoconti
  };
}

function _partitariLoad(snapshot) {
  if (_partitariCache[snapshot]) return _partitariCache[snapshot];
  const p = path.join(PARTITARI_DIR, `partitari_${snapshot}.csv`);
  if (!fs.existsSync(p)) throw new Error(`Snapshot non trovato: ${snapshot}`);
  const parsed = parsePartitariCsv(p);
  _partitariCache[snapshot] = parsed;
  return parsed;
}

// GET /api/partitari/snapshots — elenca snapshot disponibili
app.get('/api/partitari/snapshots', (req, res) => {
  try {
    const files = fs.readdirSync(PARTITARI_DIR).filter(f => /^partitari_\d{8}\.csv$/.test(f));
    const list = files.map(f => {
      const m = f.match(/partitari_(\d{4})(\d{2})(\d{2})\.csv/);
      const iso = `${m[1]}-${m[2]}-${m[3]}`;
      const display = `${m[3]}/${m[2]}/${m[1]}`;
      return { file: f, snapshot: m[1]+m[2]+m[3], iso, display };
    }).sort((a,b) => b.snapshot.localeCompare(a.snapshot));
    res.json({ snapshots: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/partitari/sottoconti?snapshot=YYYYMMDD — lista sottoconti con saldi riassuntivi
app.get('/api/partitari/sottoconti', (req, res) => {
  try {
    const snap = req.query.snapshot;
    if (!snap) return res.status(400).json({ error: 'snapshot mancante' });
    const data = _partitariLoad(snap);
    const list = Object.values(data.sottoconti).map(sc => ({
      codice: sc.codice,
      descrizione: sc.descrizione,
      has_cli_for: sc.has_cli_for,
      n_cli_for: Object.keys(sc.cli_for).length,
      n_movimenti: sc.movimenti.length + Object.values(sc.cli_for).reduce((s,c)=>s+c.movimenti.length, 0),
      saldo_iniziale: sc.totali.saldo_iniziale || 0,
      dare: sc.totali.dare,
      avere: sc.totali.avere,
      saldo_finale: sc.totali.saldo_finale
    })).sort((a,b) => a.codice.localeCompare(b.codice));
    res.json({ header: data.header, sottoconti: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/partitari?snapshot=YYYYMMDD&sottoconto=CODE[&cli_for=CODE]
// Restituisce dettaglio movimenti. Se sottoconto ha cli/for e cli_for non specificato,
// restituisce l'elenco dei cli/for con saldi. Se cli_for='__ALL__', tutti i movimenti aggregati.
app.get('/api/partitari', (req, res) => {
  try {
    const snap = req.query.snapshot;
    const scCode = req.query.sottoconto;
    const cliFor = req.query.cli_for;
    if (!snap || !scCode) return res.status(400).json({ error: 'snapshot e sottoconto richiesti' });
    const data = _partitariLoad(snap);
    const sc = data.sottoconti[scCode];
    if (!sc) return res.status(404).json({ error: 'sottoconto non trovato' });

    if (sc.has_cli_for && !cliFor) {
      // Restituisce elenco cli/for
      const list = Object.values(sc.cli_for).map(c => ({
        codice: c.codice,
        descrizione: c.descrizione,
        cf: c.cf, piva: c.piva,
        saldo_iniziale: c.totali.saldo_iniziale || 0,
        dare: c.totali.dare,
        avere: c.totali.avere,
        saldo_finale: c.totali.saldo_finale,
        n_movimenti: c.movimenti.length
      })).sort((a,b) => (a.descrizione||'').localeCompare(b.descrizione||''));
      return res.json({
        header: data.header,
        sottoconto: { codice: sc.codice, descrizione: sc.descrizione, has_cli_for: true, totali: sc.totali },
        cli_for: list
      });
    }

    if (sc.has_cli_for && cliFor && cliFor !== '__ALL__') {
      const c = sc.cli_for[cliFor];
      if (!c) return res.status(404).json({ error: 'cli/for non trovato' });
      return res.json({
        header: data.header,
        sottoconto: { codice: sc.codice, descrizione: sc.descrizione, has_cli_for: true },
        cli_for: {
          codice: c.codice, descrizione: c.descrizione, cf: c.cf, piva: c.piva,
          saldo_iniziale: c.saldo_iniziale, totali: c.totali, movimenti: c.movimenti
        }
      });
    }

    // Sottoconto generico o richiesta __ALL__
    let mov = sc.movimenti.slice();
    if (sc.has_cli_for && cliFor === '__ALL__') {
      Object.values(sc.cli_for).forEach(c => {
        c.movimenti.forEach(m => mov.push(Object.assign({}, m, { _cf_cod: c.codice, _cf_nome: c.descrizione })));
      });
    }
    mov.sort((a,b) => (a.data_reg||'').localeCompare(b.data_reg||''));

    return res.json({
      header: data.header,
      sottoconto: {
        codice: sc.codice, descrizione: sc.descrizione, has_cli_for: sc.has_cli_for,
        saldo_iniziale: sc.saldo_iniziale, totali: sc.totali
      },
      movimenti: mov
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/partitari/cli-for-all?snapshot=YYYYMMDD&tipo=clienti|fornitori|all&prefix=...
// Restituisce flat list di tutti i cli/for codificati (per popolare dropdown "sposta anticipo")
app.get('/api/partitari/cli-for-all', (req, res) => {
  try {
    let snap = req.query.snapshot;
    const tipo = (req.query.tipo || 'all').toLowerCase();
    const prefix = (req.query.prefix || '').trim();

    // Se snapshot non fornita, usa la più recente
    if (!snap) {
      const files = fs.readdirSync(PARTITARI_DIR).filter(f => /^partitari_\d{8}\.csv$/.test(f));
      if (!files.length) return res.json({ snapshot: null, items: [] });
      const latest = files.map(f => f.match(/partitari_(\d{8})\.csv/)[1]).sort().pop();
      snap = latest;
    }

    const data = _partitariLoad(snap);
    const items = [];
    for (const code of Object.keys(data.sottoconti)) {
      const sc = data.sottoconti[code];
      if (!sc.has_cli_for) continue;
      if (prefix && !code.startsWith(prefix)) continue;
      const descU = (sc.descrizione || '').toUpperCase();
      // Filtro per tipo
      if (tipo === 'clienti' && !/CLIENT/.test(descU)) continue;
      if (tipo === 'fornitori' && !/FORNIT/.test(descU)) continue;

      for (const codcf of Object.keys(sc.cli_for)) {
        const c = sc.cli_for[codcf];
        items.push({
          sottoconto: sc.codice,
          sottoconto_descr: sc.descrizione,
          codice: c.codice,
          descrizione: c.descrizione,
          cf: c.cf || '',
          piva: c.piva || '',
          saldo_finale: c.totali.saldo_finale,
          n_movimenti: c.movimenti.length
        });
      }
    }
    items.sort((a,b) => (a.descrizione||'').localeCompare(b.descrizione||''));
    res.json({ snapshot: snap, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/partitari/upload — upload di un nuovo CSV (atteso multipart o JSON con {name, content_base64})
app.post('/api/partitari/upload', express.json({ limit: '30mb' }), (req, res) => {
  try {
    const { snapshot, content_base64, confirm_overwrite } = req.body || {};
    if (!snapshot || !/^\d{8}$/.test(String(snapshot))) {
      return res.status(400).json({ error: 'snapshot (YYYYMMDD) richiesto' });
    }
    if (!content_base64) return res.status(400).json({ error: 'content_base64 mancante' });
    const buf = Buffer.from(content_base64, 'base64');
    // Verifica che sia un CSV plausibile (prima riga contiene ";")
    const first = buf.slice(0, 200).toString('utf8');
    if (!first.includes(';')) return res.status(400).json({ error: 'il file non sembra un CSV con separatore ";"' });
    const p = path.join(PARTITARI_DIR, `partitari_${snapshot}.csv`);
    const esisteGia = fs.existsSync(p);
    // Se lo snapshot esiste già e il client non ha confermato, richiedi conferma
    if (esisteGia && !confirm_overwrite) {
      const st = fs.statSync(p);
      return res.status(409).json({
        error: 'snapshot_esistente',
        message: `Lo snapshot ${snapshot} esiste già (${(st.size/1024).toFixed(1)} KB, caricato ${st.mtime.toISOString().slice(0,10)}). Vuoi sovrascriverlo?`,
        existing: { bytes: st.size, mtime: st.mtime.toISOString() }
      });
    }
    fs.writeFileSync(p, buf);
    delete _partitariCache[snapshot];
    res.json({ ok: true, file: path.basename(p), bytes: buf.length, sovrascritto: esisteGia });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/partitari/snapshot/:snapshot — elimina uno snapshot
app.delete('/api/partitari/snapshot/:snapshot', (req, res) => {
  try {
    const snap = req.params.snapshot;
    if (!snap || !/^\d{8}$/.test(snap)) return res.status(400).json({ error: 'snapshot non valido' });
    const p = path.join(PARTITARI_DIR, `partitari_${snap}.csv`);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'snapshot non trovato' });
    fs.unlinkSync(p);
    delete _partitariCache[snap];
    res.json({ ok: true, eliminato: path.basename(p) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ─── ANTICIPI (DA CLIENTI + A FORNITORI) ───────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
// Due persistenze parallele (anticipi_clienti.json, anticipi_fornitori.json)
// condividono stessi helper e stessa shape, cambiando solo il campo soggetto:
//   - clienti   → campo `cliente`
//   - fornitori → campo `fornitore`
const ANTICIPI_FILES = {
  clienti:   path.join(__dirname, 'anticipi_clienti.json'),
  fornitori: path.join(__dirname, 'anticipi_fornitori.json')
};
// Nome campo soggetto nel JSON/API per tipo
const ANTICIPI_SOGG_KEY = { clienti: 'cliente', fornitori: 'fornitore' };
// File legacy (senza suffisso tipo) — retrocompat con vecchi caller
const ANTICIPI_FILE = ANTICIPI_FILES.clienti;

function _anticipiTipoOrDie(tipo) {
  const t = (tipo || 'clienti').toLowerCase();
  if (t !== 'clienti' && t !== 'fornitori') throw new Error('tipo deve essere "clienti" o "fornitori"');
  return t;
}

function _anticipiDefault(tipo) {
  const t = _anticipiTipoOrDie(tipo);
  const titolo = t === 'clienti' ? 'ANTICIPI DA CLIENTI AEC' : 'ANTICIPI A FORNITORI AEC';
  return {
    data_riferimento: new Date().toISOString().slice(0,10),
    titolo,
    soggetto: 'AEC INTERNATIONAL SRL',
    anticipi: []
  };
}

function _anticipiLoad(tipo) {
  const t = _anticipiTipoOrDie(tipo);
  try {
    const d = JSON.parse(fs.readFileSync(ANTICIPI_FILES[t], 'utf8'));
    if (!Array.isArray(d.anticipi)) d.anticipi = [];
    return d;
  } catch {
    return _anticipiDefault(t);
  }
}

function _anticipiSave(tipo, d) {
  const t = _anticipiTipoOrDie(tipo);
  fs.writeFileSync(ANTICIPI_FILES[t], JSON.stringify(d, null, 2));
}

function _anticipiNextId(anticipi) {
  const nums = anticipi.map(a => {
    const m = (a.id||'').match(/^a_(\d+)$/);
    return m ? parseInt(m[1],10) : 0;
  });
  const max = nums.length ? Math.max.apply(null, nums) : 0;
  return 'a_' + String(max+1).padStart(3,'0');
}

// Registra i 5 endpoint CRUD per uno dei due tipi
function _anticipiMountCrud(tipo) {
  const t = _anticipiTipoOrDie(tipo);
  const soggKey = ANTICIPI_SOGG_KEY[t];
  const base = `/api/anticipi-${t}`;

  // GET — tutti gli anticipi
  app.get(base, (req, res) => {
    res.json(_anticipiLoad(t));
  });

  // POST — aggiunge o modifica (se id fornito)
  app.post(base, (req, res) => {
    try {
      const d = _anticipiLoad(t);
      const body = req.body || {};
      const id = body.id;
      // retrocompat: accetta sia "cliente" che "fornitore" nel body
      const sogg = (body[soggKey] || body.cliente || body.fornitore || '').trim();

      const row = {
        id: id || _anticipiNextId(d.anticipi),
        anno: parseInt(body.anno, 10) || new Date().getFullYear(),
        data: body.data || null,
        [soggKey]: sogg,
        importo: Number(body.importo) || 0,
        nota: (body.nota || '').trim(),
        spostato: !!body.spostato,
        spostato_il: body.spostato_il || null,
        sottoconto_target: body.sottoconto_target || null,
        cli_for_target: body.cli_for_target || null,
        note_spostamento: (body.note_spostamento || '').trim()
      };

      if (id) {
        const i = d.anticipi.findIndex(a => a.id === id);
        if (i < 0) return res.status(404).json({ error: 'non trovato' });
        d.anticipi[i] = Object.assign({}, d.anticipi[i], row);
      } else {
        d.anticipi.push(row);
      }
      _anticipiSave(t, d);
      res.json({ ok: true, anticipo: row });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE :id
  app.delete(`${base}/:id`, (req, res) => {
    try {
      const d = _anticipiLoad(t);
      const i = d.anticipi.findIndex(a => a.id === req.params.id);
      if (i < 0) return res.status(404).json({ error: 'non trovato' });
      d.anticipi.splice(i, 1);
      _anticipiSave(t, d);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST :id/sposta — marca come spostato / ripristina
  app.post(`${base}/:id/sposta`, (req, res) => {
    try {
      const d = _anticipiLoad(t);
      const i = d.anticipi.findIndex(a => a.id === req.params.id);
      if (i < 0) return res.status(404).json({ error: 'non trovato' });
      const { spostato, sottoconto_target, cli_for_target, note_spostamento } = req.body || {};
      d.anticipi[i].spostato = !!spostato;
      d.anticipi[i].spostato_il = spostato ? (new Date().toISOString()) : null;
      if (sottoconto_target !== undefined) d.anticipi[i].sottoconto_target = sottoconto_target || null;
      if (cli_for_target !== undefined)    d.anticipi[i].cli_for_target = cli_for_target || null;
      if (note_spostamento !== undefined)  d.anticipi[i].note_spostamento = note_spostamento || '';
      _anticipiSave(t, d);
      res.json({ ok: true, anticipo: d.anticipi[i] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST import-csv — massivo (CSV ;)
  // Formato atteso: Anno;Data (YYYY-MM-DD o DD/MM/YYYY);<Cliente|Fornitore>;Importo;Nota
  app.post(`${base}/import-csv`, (req, res) => {
    try {
      const csv = (req.body && req.body.csv) || '';
      const replace = !!(req.body && req.body.replace);
      if (!csv) return res.status(400).json({ error: 'csv mancante' });

      const lines = csv.split(/\r?\n/).filter(l => l.trim());
      if (!lines.length) return res.status(400).json({ error: 'csv vuoto' });

      // Skip header se inizia con "Anno" o similari (accetta cliente/fornitore/soggetto)
      let startIdx = 0;
      const firstCells = _parseCsvLine(lines[0]).map(s => (s||'').toLowerCase());
      if (firstCells.some(c => c.includes('anno') || c.includes('cliente') || c.includes('fornitore') || c.includes('soggetto') || c.includes('importo'))) startIdx = 1;

      const rows = [];
      for (let i = startIdx; i < lines.length; i++) {
        const c = _parseCsvLine(lines[i]);
        if (!c.length) continue;
        const anno = parseInt(c[0], 10);
        const rawDate = (c[1] || '').trim();
        const dataIso = rawDate.match(/^\d{4}-\d{2}-\d{2}/) ? rawDate :
          (rawDate.match(/^(\d{2})\/(\d{2})\/(\d{4})/) ? `${RegExp.$3}-${RegExp.$2}-${RegExp.$1}` : null);
        const sogg = (c[2] || '').trim();
        const importo = _partNum(c[3]);
        const nota = (c[4] || '').trim();
        if (!sogg || !importo) continue;
        rows.push({ anno: anno || new Date().getFullYear(), data: dataIso, [soggKey]: sogg, importo, nota });
      }

      const d = _anticipiLoad(t);
      if (replace) d.anticipi = [];
      rows.forEach(r => {
        d.anticipi.push({
          id: _anticipiNextId(d.anticipi),
          anno: r.anno, data: r.data, [soggKey]: r[soggKey], importo: r.importo, nota: r.nota,
          spostato: false, spostato_il: null,
          sottoconto_target: null, cli_for_target: null, note_spostamento: ''
        });
      });
      _anticipiSave(t, d);
      res.json({ ok: true, importati: rows.length, totale: d.anticipi.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

// Mount per entrambi i tipi
_anticipiMountCrud('clienti');
_anticipiMountCrud('fornitori');

// ═════════════════════════════════════════════════════════════════════════════
// ─── PARTITARI DANEA (ricostruiti da TDocTestate + TPrimaNota) ──────────────
// ═════════════════════════════════════════════════════════════════════════════
// TipoDoc contabili Danea Easyfatt (verificati su DB AEC — aprile 2026)
//   CLIENTI   (vendita):  F = Fattura immediata, I = Fattura Accompagnatoria, N = NC cliente
//   FORNITORI (acquisto): U = Fattura fornitore, N = NC fornitore
//
// AEC emette prevalentemente fatture accompagnatorie (I) insieme alla merce, non F.
// I TipoDoc NON contabili (scarta da partitari): C=ord.cliente, D=DDT emesso,
//   E=ordine fornitore, H=arrivo/carico magazzino, Q=preventivo, G=ord.fornitore (raro).
//
// NOTA su 'N' (dual-role): un'anagrafica con Cliente=1 AND Fornitore=1 potrebbe avere
// sia NCV (nota credito vendita) che NCA (nota credito acquisto), entrambe con TipoDoc=N.
// La classificazione dare/avere è già corretta (segno TotDoc × ruolo), ma se vedi
// una NCV che "inquina" il partitario fornitore di un dual-role controlla il segno.
//
// Verificato con: /api/debug/fornitori-tipodoc → 'U' è il 73% dei documenti
// post-2026-01-01 per anagrafiche Fornitore=1 (315 fatture, €1,18M).
const DANEA_TIPODOC_CLIENTI   = ['F', 'I', 'N'];
const DANEA_TIPODOC_FORNITORI = ['U', 'N'];

// ─── CUTOFF 01/01/2026: NON importiamo nessun movimento Danea < CUTOFF. ──────
//   Il saldo iniziale al 01/01/2026 viene letto dal PDF ufficiale di bilancio
//   (saldi_iniziali_2026.json) — non è più calcolato sommando lo storico Danea.
// Se in futuro si cambierà esercizio basterà bumpare queste due costanti e
// rigenerare il JSON dei saldi.
const DANEA_CUTOFF         = '2026-01-01';  // fiscal-year opening
const DANEA_CUTOFF_DEFAULT = DANEA_CUTOFF;  // compat. alias (vecchie chiamate)

// _isoFrom: forziamo SEMPRE il cutoff. Il parametro ?from= è ormai ignorato
// (lo lasciamo nella signature per retro-compatibilità con i caller esistenti).
function _isoFrom(/* q, alIso */) {
  return DANEA_CUTOFF;
}
// Parametro "al" (data fine): null se non specificato
function _isoAl(q) {
  const s = (q || '').toString().trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

// ─── SALDI INIZIALI 01/01/2026 (da PDF bilancio) ────────────────────────────
// Caricati una volta a startup da saldi_iniziali_2026.json e indicizzati per
// nome normalizzato + ruolo. Matching case/punteggiatura-insensitive.
const SALDI_INIZIALI_FILE = path.join(__dirname, 'saldi_iniziali_2026.json');
let _saldiIniziali = null;      // oggetto crudo del JSON
let _saldiIndexCli = new Map(); // nomeNorm -> [entry, ...] per clienti
let _saldiIndexFor = new Map(); // nomeNorm -> [entry, ...] per fornitori

// Normalizza nome per lookup: UPPER, niente accenti/punteggiatura, compatta
// sequenze di iniziali singole ("S R L" → "SRL", "C T S" → "CTS") e rimuove
// forme societarie comuni. Unifica "DURANTE S.R.L." / "DURANTE SRL" / "Durante Srl".
function _normNome(s) {
  let x = (s || '').toString()
    .toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // accenti
    .replace(/[^A-Z0-9 ]+/g, ' ')                      // punteggiatura → spazio
    .replace(/\s+/g, ' ')
    .trim();
  // Compatta sequenze di iniziali singole ("S R L" → "SRL", "C T S" → "CTS")
  x = x.replace(/\b[A-Z](?:\s[A-Z]\b)+/g, m => m.replace(/\s/g, ''));
  // Rimuovi forme societarie compatte
  x = x.replace(/\b(SRL|SRLS|SPA|SAS|SNC|SCOOP|SOCIETA|SOC|COOP|COOPERATIVA|UNIPERSONALE|LTD|LLC|GMBH|SA|AG|BV|INC|CORP|CO)\b/g, '');
  // Rimuovi "& C", "E C" e "DI XXX" (distrae nei match)
  x = x.replace(/\b(E|&)\s*C\b/g, '');
  x = x.replace(/\s+/g, ' ').trim();
  return x;
}

function _saldiInizialiLoad() {
  try {
    const raw = fs.readFileSync(SALDI_INIZIALI_FILE, 'utf8');
    _saldiIniziali = JSON.parse(raw);
  } catch (e) {
    console.warn('[saldi_iniziali] File non trovato o invalido:', e.message);
    _saldiIniziali = { _meta: {}, clienti: [], fornitori: [] };
  }
  _saldiIndexCli = new Map();
  _saldiIndexFor = new Map();
  (_saldiIniziali.clienti || []).forEach(e => {
    const k = _normNome(e.nome);
    if (!_saldiIndexCli.has(k)) _saldiIndexCli.set(k, []);
    _saldiIndexCli.get(k).push(e);
  });
  (_saldiIniziali.fornitori || []).forEach(e => {
    const k = _normNome(e.nome);
    if (!_saldiIndexFor.has(k)) _saldiIndexFor.set(k, []);
    _saldiIndexFor.get(k).push(e);
  });
  console.log(`[saldi_iniziali] Caricato: ${(_saldiIniziali.clienti||[]).length} clienti, ${(_saldiIniziali.fornitori||[]).length} fornitori.`);
}
_saldiInizialiLoad();

// Lookup saldo iniziale per anagrafica:
// - Ritorna { saldo_signed, entries: [...], match_type: 'exact'|'partial'|'none' }
// - Se più sottoconti (es. DURANTE in 102280 + 102295), somma i saldi.
// - Se nessun match, saldo_signed = 0.
// - saldo_signed convenzione:
//     clienti: D → positivo (credito verso cliente), A → negativo
//     fornitori: A → positivo (debito verso fornitore), D → negativo (anticipo)
function _saldoInizialeLookup(nome, ruolo) {
  const isFor = ruolo === 'fornitori';
  const index = isFor ? _saldiIndexFor : _saldiIndexCli;
  const norm = _normNome(nome);
  if (!norm) return { saldo_signed: 0, entries: [], match_type: 'none', nome_norm: '' };

  // 1) match esatto
  let entries = index.get(norm) || [];
  let matchType = entries.length ? 'exact' : 'none';

  // 2) match parziale "token-safe":
  //    - Prima parola coincide esattamente ed è ≥4 char
  //    - AND almeno una di:
  //        a) entrambi i lati hanno una sola parola (l'esatto l'avrebbe già trovato,
  //           quindi qui si triggera solo se i restanti char vengono mangiati da
  //           _normNome: di fatto caso raro, lasciato per sicurezza)
  //        b) anche la seconda parola coincide token-to-token
  //
  //    NON accettiamo più match asimmetrici (1 parola vs 2+ parole):
  //    era la sorgente del falso positivo "CATALDO DURANTE" (persona) ↔ "DURANTE" (società).
  //    Se un'anagrafica Danea è persona fisica con un cognome che è anche
  //    ragione sociale, il saldo iniziale del PDF NON le verrà attribuito.
  if (!entries.length) {
    const toks = norm.split(' ').filter(Boolean);
    const prima = toks[0];
    if (prima && prima.length >= 4) {
      for (const [k, v] of index.entries()) {
        const kToks = k.split(' ').filter(Boolean);
        if (kToks[0] !== prima) continue;          // la prima parola DEVE combaciare
        const okSingola = toks.length === 1 && kToks.length === 1;
        const okDoppia  = toks.length >= 2 && kToks.length >= 2 && toks[1] === kToks[1];
        if (okSingola || okDoppia) {
          entries = entries.concat(v);
          matchType = 'partial';
        }
      }
    }
  }

  // Calcola saldo signed (conventione: positivo = dovuto alla società, negativo = anticipo/anomalia)
  let saldoSigned = 0;
  entries.forEach(e => {
    if (isFor) {
      // fornitori: A = dovuto a fornitore (positivo), D = anticipo (negativo)
      saldoSigned += (e.da === 'A' ? 1 : -1) * Number(e.saldo || 0);
    } else {
      // clienti: D = credito verso cliente (positivo), A = nota credito / anticipo (negativo)
      saldoSigned += (e.da === 'D' ? 1 : -1) * Number(e.saldo || 0);
    }
  });

  return {
    saldo_signed: saldoSigned,
    entries,
    match_type: entries.length ? matchType : 'none',
    nome_norm: norm
  };
}

// Espone il meta per il frontend (data riferimento, totali, ecc.)
function _saldiInizialiMeta() {
  return {
    ..._saldiIniziali._meta,
    totali: _saldiIniziali.totali || null,
    n_clienti: (_saldiIniziali.clienti || []).length,
    n_fornitori: (_saldiIniziali.fornitori || []).length
  };
}

// Funzione riutilizzabile: restituisce lista anagrafiche Danea con saldo calcolato.
// NUOVO APPROCCIO (da 2026/1):
//   - Saldo iniziale = da PDF bilancio 31/12/2025 (file saldi_iniziali_2026.json)
//   - Movimenti = solo TDocTestate/TPrimaNota >= DANEA_CUTOFF (01/01/2026)
//   - Nessuna importazione di dati Danea pre-cutoff.
// Il parametro `fromIso` è ignorato (viene forzato a DANEA_CUTOFF); resta nella
// signature solo per retro-compatibilità con i caller legacy.
async function _getDaneaAnagraficheConSaldo(tipoReq, fromIso, alIso, soloConMov) {
  const cutoff = DANEA_CUTOFF;
  const alFilterDoc = alIso ? `AND d."DataDoc" <= '${alIso}'` : '';
  const alFilterPag = alIso ? `AND p."DataPagam" <= '${alIso}'` : '';

  const filtroAnagr = tipoReq === 'fornitori' ? `a."Fornitore" = 1`
                    : tipoReq === 'tutti'      ? `(a."Cliente" = 1 OR a."Fornitore" = 1)`
                                                : `a."Cliente" = 1`;

  const tipiDocSet = tipoReq === 'fornitori' ? DANEA_TIPODOC_FORNITORI
                   : tipoReq === 'tutti'      ? Array.from(new Set([...DANEA_TIPODOC_CLIENTI, ...DANEA_TIPODOC_FORNITORI]))
                                              : DANEA_TIPODOC_CLIENTI;
  const tipiDocIn = tipiDocSet.map(t => `'${t}'`).join(',');

  // Solo movimenti >= cutoff: il saldo iniziale viene dal PDF (lookup sotto).
  const docRows = await query(`
    SELECT a."IDAnagr" AS idanagr,
           a."CodAnagr" AS codanagr,
           a."Nome" AS nome,
           a."CodiceFiscale" AS codicefiscale,
           a."PartitaIva" AS partitaiva,
           a."Cliente" AS cliente, a."Fornitore" AS fornitore,
           SUM(CASE WHEN d."TotDoc" > 0 THEN d."TotDoc" ELSE 0 END) AS post_pos,
           SUM(CASE WHEN d."TotDoc" < 0 THEN -d."TotDoc" ELSE 0 END) AS post_neg,
           COUNT(d."IDDoc") AS n_doc_post
    FROM "TAnagrafica" a
    LEFT JOIN "TDocTestate" d
           ON d."IDAnagr" = a."IDAnagr"
          AND d."TipoDoc" IN (${tipiDocIn})
          AND d."DataDoc" >= '${cutoff}'
          ${alFilterDoc}
    WHERE ${filtroAnagr}
    GROUP BY a."IDAnagr", a."CodAnagr", a."Nome", a."CodiceFiscale", a."PartitaIva", a."Cliente", a."Fornitore"
  `);

  // Pagamenti Danea >= cutoff. Includiamo anche gli acconti senza IDDoc (IDDoc=0/null).
  // Escludiamo i giroconti.
  const pagRows = await query(`
    SELECT p."IDAnagr" AS idanagr,
           SUM(p."Importo") AS post_tot,
           COUNT(*) AS n_pag_post
    FROM "TPrimaNota" p
    LEFT JOIN "TDocTestate" d ON d."IDDoc" = p."IDDoc"
    WHERE p."Saldato" = 1 AND p."DataPagam" IS NOT NULL
      AND (p."IDGiroconto" IS NULL OR p."IDGiroconto" = 0)
      AND p."DataPagam" >= '${cutoff}'
      AND (d."TipoDoc" IN (${tipiDocIn}) OR p."IDDoc" IS NULL OR p."IDDoc" = 0)
      ${alFilterPag}
    GROUP BY p."IDAnagr"
  `);
  const pagMap = {};
  pagRows.forEach(r => { pagMap[r.idanagr] = r; });

  const items = docRows.map(r => {
    const pag = pagMap[r.idanagr] || { post_tot: 0, n_pag_post: 0 };
    const isFornitore = tipoReq === 'fornitori'
                      || (tipoReq === 'tutti' && r.fornitore === 1);
    let postDare, postAvere;
    // Danea TPrimaNota sign convention (verificato aprile 2026):
    //   clienti:   Importo > 0 = incasso (inflow)  → postAvere += post_tot
    //   fornitori: Importo < 0 = pagamento (outflow) → postDare += (-post_tot)
    // Quindi per fornitori neghiamo post_tot per ottenere il valore assoluto positivo.
    if (isFornitore) {
      postDare  = (r.post_neg || 0) - (pag.post_tot || 0);  // NC (pos) + |pagamenti| (neg→pos)
      postAvere = (r.post_pos || 0);
    } else {
      postDare  = (r.post_pos || 0);
      postAvere = (r.post_neg || 0) + (pag.post_tot || 0);  // NC (pos) + incassi (pos)
    }
    // Saldo periodo in convention contabile "dare - avere":
    //   CLIENTI   → saldo positivo = credito aperto verso cliente (attivo)
    //   FORNITORI → saldo negativo = debito aperto verso fornitore (passivo)
    // Coerente con Merkaba / mastrini AGO.
    const saldoPeriodo = postDare - postAvere;
    // Saldo iniziale da PDF ufficiale (lookup per nome + ruolo)
    const ruolo = isFornitore ? 'fornitori' : 'clienti';
    const lookup = _saldoInizialeLookup(r.nome, ruolo);
    const saldoIniziale = lookup.saldo_signed;
    // Il lookup usa convention "positivo=debito" per fornitori (da PDF AGO).
    // Per sommarlo al saldoPeriodo (convention dare-avere) serve invertirlo sui fornitori:
    // fornitore con debito 5.000 → saldoIniziale=+5.000 → saldoIniz_DA = -5.000 (avere lato passivo).
    const saldoInizialeDA = isFornitore ? -saldoIniziale : saldoIniziale;
    return {
      idanagr: r.idanagr,
      codanagr: (r.codanagr || '').trim(),
      nome: (r.nome || '').trim(),
      cf: (r.codicefiscale || '').trim(),
      piva: (r.partitaiva || '').trim(),
      cliente: r.cliente === 1,
      fornitore: r.fornitore === 1,
      saldo_iniziale: saldoIniziale,
      saldo_iniziale_match: lookup.match_type,   // 'exact'|'partial'|'none'
      saldo_iniziale_sottoconti: lookup.entries.map(e => e.sottoconto), // es. ['102280 000']
      dare: postDare,
      avere: postAvere,
      saldo: saldoInizialeDA + saldoPeriodo,    // convention dare-avere (fornitore: negativo=debito)
      n_doc: r.n_doc_post || 0,
      n_pag: pag.n_pag_post || 0
    };
  });

  let filtered = items;
  if (soloConMov) filtered = filtered.filter(x => x.n_doc > 0 || x.n_pag > 0 || Math.abs(x.saldo_iniziale) > 0.01);
  filtered.sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));

  const totali = filtered.reduce((acc, x) => {
    acc.saldo_iniziale += x.saldo_iniziale;
    acc.dare += x.dare;
    acc.avere += x.avere;
    acc.saldo += x.saldo;
    return acc;
  }, { saldo_iniziale:0, dare:0, avere:0, saldo:0 });

  return { items: filtered, totali };
}

// GET /api/saldi-iniziali — ritorna i saldi iniziali ufficiali (PDF bilancio).
// Include _meta + lista completa clienti/fornitori e totali.
app.get('/api/saldi-iniziali', (req, res) => {
  try {
    res.json({
      _meta: _saldiInizialiMeta(),
      cutoff: DANEA_CUTOFF,
      clienti:   _saldiIniziali.clienti || [],
      fornitori: _saldiIniziali.fornitori || []
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/saldi-iniziali/reload — ricarica il JSON da disco (utile se editato a caldo)
app.post('/api/saldi-iniziali/reload', (req, res) => {
  try {
    _saldiInizialiLoad();
    res.json({ ok: true, meta: _saldiInizialiMeta() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/partitari-danea/anagrafiche?tipo=clienti|fornitori|tutti&solo_con_movim=1&al=YYYY-MM-DD
// NUOVO: saldo iniziale sempre dal PDF bilancio (01/01/2026). Movimenti solo >= cutoff.
// Il parametro `from` è ormai ignorato.
app.get('/api/partitari-danea/anagrafiche', async (req, res) => {
  try {
    const tipoReq    = (req.query.tipo || 'clienti').toLowerCase();
    const soloConMov = req.query.solo_con_movim !== '0';
    const alIso      = _isoAl(req.query.al);
    const fromIso    = _isoFrom(req.query.from, alIso);
    const { items, totali } = await _getDaneaAnagraficheConSaldo(tipoReq, fromIso, alIso, soloConMov);
    res.json({ tipo: tipoReq, from: fromIso, al: alIso, items, totali });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── QUADRATURA PARTITARI: confronta Danea ↔ Merkaba ─────────────────────────
// Normalizzazione nome: rimuove forme societarie, punteggiatura, spazi multipli
function _qpNormNome(s) {
  let x = (s || '').toString().toUpperCase();
  x = x.replace(/[.\,\-_'&()\/\\]+/g, ' ');
  x = x.replace(/\b(SRL|SRLS|SPA|SAS|SNC|S\s*R\s*L|S\s*P\s*A|DITTA\s+INDIVIDUALE|SOCIETA|SOC|COOP|COOPERATIVA|S\s*COOP)\b/g, '');
  x = x.replace(/\s+/g, ' ').trim();
  return x;
}
// Normalizzazione P.IVA: estrae solo cifre e restituisce le ultime 8
// (ignora prefisso nazione "IT", spazi, trattini, zeri/caratteri extra).
// Sotto le 8 cifre torna l'intero (per partite IVA esterne UE troncate).
function _qpNormPiva(s) {
  const d = ((s || '').toString()).replace(/\D/g, '');
  if (!d) return '';
  return d.length >= 8 ? d.slice(-8) : d;
}
// Normalizzazione CF: toUpperCase + rimuove spazi/trattini.
function _qpNormCf(s) {
  return ((s || '').toString()).toUpperCase().replace(/[\s\-]/g, '');
}

// GET /api/quadratura-partitari?snapshot=YYYYMMDD&tipo=clienti|fornitori&sottoconto=<code>&al=YYYY-MM-DD&tolleranza=0.01
app.get('/api/quadratura-partitari', async (req, res) => {
  try {
    const snapshot   = (req.query.snapshot || '').trim();
    const tipoReq    = (req.query.tipo || 'clienti').toLowerCase();
    const sottoSel   = (req.query.sottoconto || '').trim();        // codice sottoconto Merkaba (es. '102280 000')
    const alIso      = _isoAl(req.query.al);
    const tolleranza = Math.max(0, parseFloat(req.query.tolleranza) || 0.01);
    // fromIso = apertura esercizio di `al` (YYYY-01-01). Non più configurabile.
    const fromIso    = _isoFrom(req.query.from, alIso);

    if (!snapshot || !/^\d{8}$/.test(snapshot)) return res.status(400).json({ error: 'snapshot (YYYYMMDD) richiesto' });
    if (tipoReq !== 'clienti' && tipoReq !== 'fornitori') return res.status(400).json({ error: 'tipo: clienti o fornitori' });

    // 1) Merkaba: carica snapshot + aggrega cli_for dai sottoconti selezionati
    let merkabaData;
    try { merkabaData = _partitariLoad(snapshot); }
    catch(e) { return res.status(404).json({ error: 'Snapshot Merkaba non trovato: ' + snapshot }); }

    // Euristica: un sottoconto è "clienti" se desc contiene "client" e NON "fornit";
    //           è "fornitori" se desc contiene "fornit".
    // Sottoconti ambigui (es. "Banca c/effetti", "cessioni crediti") vengono esclusi a meno che
    // l'utente specifichi il sottoconto manualmente.
    const _scMatchTipo = (sc, tipo) => {
      const d = (sc.descrizione || '').toLowerCase();
      const hasCli = /client/.test(d);
      const hasFor = /fornit/.test(d);
      if (tipo === 'clienti')   return hasCli && !hasFor;
      if (tipo === 'fornitori') return hasFor;
      return false;
    };

    // Raccogli cli_for: se sottoconto specifico → solo quello; altrimenti tutti i sottoconti
    // has_cli_for FILTRATI per tipo (clienti vs fornitori)
    const merkabaList = [];
    const sottocontiInclusi = [];
    Object.values(merkabaData.sottoconti || {}).forEach(sc => {
      if (!sc.has_cli_for) return;
      if (sottoSel) {
        if (sc.codice !== sottoSel) return;    // scelta manuale: rispetta
      } else {
        if (!_scMatchTipo(sc, tipoReq)) return; // auto: filtra per tipo
      }
      sottocontiInclusi.push({ codice: sc.codice, descrizione: sc.descrizione });
      Object.values(sc.cli_for || {}).forEach(c => {
        const saldo = (c.totali && c.totali.saldo_finale) || 0;
        merkabaList.push({
          sottoconto:     sc.codice,
          sottoconto_desc: sc.descrizione,
          codice:         c.codice,
          nome:           c.descrizione || '',
          cf:             c.cf || '',
          piva:           c.piva || '',
          saldo:          saldo
        });
      });
    });

    // 2) Danea: chiama il saldo (solo_con_movim=false per avere TUTTO e match completo)
    const { items: daneaItems } = await _getDaneaAnagraficheConSaldo(tipoReq, fromIso, alIso, false);

    // 3) Build lookup maps per Merkaba (per CF, PIVA e nome normalizzato)
    // CF: uppercase + no spazi/trattini
    // PIVA: ultime 8 cifre (tollera prefisso IT, spazi, punteggiatura)
    const mByCf = {}, mByPiva = {}, mByNome = {};
    merkabaList.forEach(m => {
      const cfK = _qpNormCf(m.cf);
      if (cfK) (mByCf[cfK] = mByCf[cfK] || []).push(m);
      const pK = _qpNormPiva(m.piva);
      if (pK) (mByPiva[pK] = mByPiva[pK] || []).push(m);
      const nk = _qpNormNome(m.nome);
      if (nk) (mByNome[nk] = mByNome[nk] || []).push(m);
    });

    const usatiMerk = new Set(); // merkaba index già accoppiati
    const righe = [];

    // 3a) Match Danea → Merkaba
    daneaItems.forEach(d => {
      const saldoD = +(d.saldo || 0);
      let match = null, matchBy = null;

      const cfKey   = _qpNormCf(d.cf);
      const pivaKey = _qpNormPiva(d.piva);
      const nkey    = _qpNormNome(d.nome);

      if (cfKey && mByCf[cfKey]) {
        match = mByCf[cfKey].find(m => !usatiMerk.has(m)); if (match) matchBy = 'cf';
      }
      if (!match && pivaKey && mByPiva[pivaKey]) {
        match = mByPiva[pivaKey].find(m => !usatiMerk.has(m)); if (match) matchBy = 'piva';
      }
      if (!match && nkey && mByNome[nkey]) {
        match = mByNome[nkey].find(m => !usatiMerk.has(m)); if (match) matchBy = 'nome';
      }

      if (match) {
        usatiMerk.add(match);
        const saldoM = +(match.saldo || 0);
        const diff   = saldoD - saldoM;
        const stato  = Math.abs(diff) <= tolleranza ? 'ok' : 'discrepanza';
        righe.push({
          nome:             d.nome,
          nome_merkaba:     match.nome,
          cf:               d.cf || match.cf,
          piva:             d.piva || match.piva,
          codanagr_danea:   d.codanagr,
          idanagr_danea:    d.idanagr,
          codice_merkaba:   match.codice,
          sottoconto:       match.sottoconto,
          sottoconto_desc:  match.sottoconto_desc,
          saldo_danea:      saldoD,
          saldo_merkaba:    saldoM,
          diff:             diff,
          // Scomposizione saldo Danea (per debug: saldo_iniziale pre-from + dare/avere nel periodo)
          d_saldo_iniziale: +(d.saldo_iniziale || 0),
          d_dare:           +(d.dare || 0),
          d_avere:          +(d.avere || 0),
          d_n_doc:          d.n_doc || 0,
          d_n_pag:          d.n_pag || 0,
          stato:            stato,
          match_by:         matchBy,
          solo_danea:       false,
          solo_merkaba:     false
        });
      } else if (Math.abs(saldoD) > tolleranza) {
        // Solo in Danea (con saldo significativo)
        righe.push({
          nome:          d.nome,
          cf:            d.cf,
          piva:          d.piva,
          codanagr_danea: d.codanagr,
          idanagr_danea: d.idanagr,
          saldo_danea:   saldoD,
          saldo_merkaba: null,
          diff:          saldoD,
          d_saldo_iniziale: +(d.saldo_iniziale || 0),
          d_dare:        +(d.dare || 0),
          d_avere:       +(d.avere || 0),
          d_n_doc:       d.n_doc || 0,
          d_n_pag:       d.n_pag || 0,
          stato:         'solo_danea',
          match_by:      null,
          solo_danea:    true,
          solo_merkaba:  false
        });
      }
      // Se saldoD == 0 e non c'è match, lo saltiamo: non è interessante
    });

    // 3b) Merkaba rimanenti (non matchati) con saldo significativo → "solo_merkaba"
    merkabaList.forEach(m => {
      if (usatiMerk.has(m)) return;
      const saldoM = +(m.saldo || 0);
      if (Math.abs(saldoM) <= tolleranza) return;
      righe.push({
        nome:            m.nome,
        cf:              m.cf,
        piva:            m.piva,
        codice_merkaba:  m.codice,
        sottoconto:      m.sottoconto,
        sottoconto_desc: m.sottoconto_desc,
        saldo_danea:     null,
        saldo_merkaba:   saldoM,
        diff:            -saldoM,
        stato:           'solo_merkaba',
        match_by:        null,
        solo_danea:      false,
        solo_merkaba:    true
      });
    });

    // Ordina alfabeticamente per nome (it-IT, case/accent-insensitive).
    // Se il nome è vuoto cade su nome_merkaba.
    righe.sort((a,b) => {
      const na = (a.nome || a.nome_merkaba || '').trim();
      const nb = (b.nome || b.nome_merkaba || '').trim();
      return na.localeCompare(nb, 'it-IT', { sensitivity: 'base' });
    });

    const sommario = {
      totale:         righe.length,
      ok:             righe.filter(r => r.stato === 'ok').length,
      discrepanza:    righe.filter(r => r.stato === 'discrepanza').length,
      solo_danea:     righe.filter(r => r.stato === 'solo_danea').length,
      solo_merkaba:   righe.filter(r => r.stato === 'solo_merkaba').length,
      tot_saldo_danea:   righe.reduce((s,r) => s + (r.saldo_danea   || 0), 0),
      tot_saldo_merkaba: righe.reduce((s,r) => s + (r.saldo_merkaba || 0), 0),
      tot_diff:          righe.reduce((s,r) => s + (r.diff          || 0), 0)
    };

    // Elenco sottoconti Merkaba disponibili (per UI: permette scelta).
    // Tagghiamo ciascuno con il tipo inferito dalla descrizione (clienti / fornitori / altro).
    const sottoFlags = Object.values(merkabaData.sottoconti || {})
      .filter(sc => sc.has_cli_for)
      .map(sc => {
        const d = (sc.descrizione || '').toLowerCase();
        const hasCli = /client/.test(d);
        const hasFor = /fornit/.test(d);
        const tipoAuto = hasCli && !hasFor ? 'clienti' : (hasFor ? 'fornitori' : 'altro');
        return {
          codice: sc.codice, descrizione: sc.descrizione,
          n_cli_for: Object.keys(sc.cli_for||{}).length,
          tipo_auto: tipoAuto
        };
      });

    res.json({
      snapshot, tipo: tipoReq, al: alIso, from: fromIso, tolleranza,
      sottoconti_disponibili: sottoFlags,
      sottoconti_inclusi:     sottocontiInclusi,
      righe, sommario
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// GET /api/partitari-danea/:idAnagr?al=YYYY-MM-DD&ruolo=clienti|fornitori&tipodoc_all=1
// NUOVO: il saldo iniziale è SEMPRE al DANEA_CUTOFF (01/01/2026), letto dal PDF
// ufficiale di bilancio. Non importiamo nessun dato Danea pre-cutoff.
// `ruolo` override per anagrafiche dual-role. Default: Cliente=1 → clienti.
// `tipodoc_all=1` bypassa il filtro TipoDoc (utile finché non conosciamo i codici
// acquisto reali di questa installazione Easyfatt — vedi /api/debug/fornitori-tipodoc).
app.get('/api/partitari-danea/:idAnagr', async (req, res) => {
  try {
    const id = parseInt(req.params.idAnagr, 10);
    if (!id) return res.status(400).json({ error: 'idAnagr non valido' });
    const alIso   = _isoAl(req.query.al);
    const fromIso = DANEA_CUTOFF;                          // cutoff fisso
    const ruoloReq = (req.query.ruolo || '').toLowerCase();
    const tipoDocAll = req.query.tipodoc_all === '1' || req.query.tipodoc_all === 'true';
    const alDoc   = alIso ? `AND "DataDoc" <= '${alIso}'` : '';
    const alDocP  = alIso ? `AND p."DataPagam" <= '${alIso}'` : ''; // alias p. nella query pags

    // Anagrafica
    const anaRows = await query(`SELECT * FROM "TAnagrafica" WHERE "IDAnagr" = ${id}`);
    if (!anaRows.length) return res.status(404).json({ error: 'Anagrafica non trovata' });
    const a = anaRows[0];
    // Ruolo: override esplicito > Cliente=1 > Fornitore=1
    const isFornitore = ruoloReq === 'fornitori' ? true
                      : ruoloReq === 'clienti'   ? false
                      : (a.cliente === 1 ? false : a.fornitore === 1);
    const tipiDoc = isFornitore ? DANEA_TIPODOC_FORNITORI : DANEA_TIPODOC_CLIENTI;
    const tipiDocIn = tipiDoc.map(t => `'${t}'`).join(',');
    // Filtro SQL: se tipodoc_all → nessun filtro, altrimenti IN (...)
    const tipoDocFiltroDoc = tipoDocAll ? '' : `AND "TipoDoc" IN (${tipiDocIn})`;
    const tipoDocFiltroPag = tipoDocAll
      ? ''
      : `AND (d."TipoDoc" IN (${tipiDocIn}) OR p."IDDoc" IS NULL OR p."IDDoc" = 0)`;

    // ──── Saldo iniziale dal PDF ufficiale (saldi_iniziali_2026.json) ────
    const ruolo     = isFornitore ? 'fornitori' : 'clienti';
    const siLookup  = _saldoInizialeLookup(a.nome, ruolo);
    const saldoIniziale = siLookup.saldo_signed;

    // ──── Documenti >= cutoff (01/01/2026) fino ad alIso ────
    const docs = await query(`
      SELECT "IDDoc" AS iddoc, "TipoDoc" AS tipodoc, "DataDoc" AS datadoc,
             "NumDoc" AS numdoc, "DescDoc" AS descdoc,
             "TotDoc" AS totdoc, "NomeReport" AS nomereport,
             "Pagam_Saldato" AS saldato,
             "Pagam_ImportoSaldato" AS pag_saldato,
             "Pagam_ImportoDaSaldare" AS pag_da_saldare
      FROM "TDocTestate"
      WHERE "IDAnagr" = ${id}
        ${tipoDocFiltroDoc}
        AND "DataDoc" >= '${fromIso}'
        ${alDoc}
      ORDER BY "DataDoc"
    `);

    // ──── Pagamenti saldati >= cutoff fino ad alIso (escludo giroconti) ────
    const pags = await query(`
      SELECT p."IDPrimaNota" AS idprimanota, p."IDDoc" AS iddoc,
             p."DataPagam" AS datapagam, p."DataScad" AS datascad,
             p."Importo" AS importo, p."Risorsa" AS risorsa,
             p."CategPagamento" AS categpagamento,
             p."RifPagam" AS rifpagam, p."NomePagamDoc" AS nomepagamdoc,
             p."IsAcconto" AS isacconto,
             d."NumDoc" AS doc_numdoc, d."TipoDoc" AS doc_tipodoc
      FROM "TPrimaNota" p
      LEFT JOIN "TDocTestate" d ON d."IDDoc" = p."IDDoc"
      WHERE p."IDAnagr" = ${id}
        AND p."Saldato" = 1 AND p."DataPagam" IS NOT NULL
        AND (p."IDGiroconto" IS NULL OR p."IDGiroconto" = 0)
        AND p."DataPagam" >= '${fromIso}'
        ${tipoDocFiltroPag}
        ${alDocP}
      ORDER BY p."DataPagam"
    `);

    // ──── Costruisci righe partitario ────
    const righe = [];

    // Riga "Saldo iniziale al 01/01/2026" (da PDF) — sempre inserita se diversa da 0
    // Convention contabile:
    //   CLIENTI (attivo): credito (D=+)→ DARE, NC/anticipo (A=-) → AVERE
    //   FORNITORI (passivo): debito (A=+) → AVERE, anticipo (D=-) → DARE
    if (Math.abs(saldoIniziale) > 0.005) {
      let dareSI, avereSI;
      if (isFornitore) {
        dareSI  = saldoIniziale < 0 ? -saldoIniziale : 0;
        avereSI = saldoIniziale > 0 ?  saldoIniziale : 0;
      } else {
        dareSI  = saldoIniziale > 0 ?  saldoIniziale : 0;
        avereSI = saldoIniziale < 0 ? -saldoIniziale : 0;
      }
      const sottocontiNote = (siLookup.entries || [])
        .map(e => `${e.sottoconto} ${e.sottoconto_desc} (€ ${Number(e.saldo).toLocaleString('it-IT', {minimumFractionDigits:2, maximumFractionDigits:2})} ${e.da})`)
        .join(' + ');
      righe.push({
        tipo: 'saldo_iniziale',
        data: '2025-12-31',
        doc: 'Saldo al 31/12/2025',
        descrizione: `Saldo iniziale ufficiale da bilancio AEC (PDF 31/12/2025) · ${sottocontiNote || 'nessun sottoconto'}`,
        dare: dareSI,
        avere: avereSI,
        _ord: 0
      });
    }

    docs.forEach(d => {
      const totdoc = d.totdoc || 0;
      const isNeg = totdoc < 0;
      let dare = 0, avere = 0;
      if (isFornitore) {
        if (isNeg) dare = -totdoc; else avere = totdoc;
      } else {
        if (isNeg) avere = -totdoc; else dare = totdoc;
      }
      const descr = (d.descdoc || d.nomereport || '').toString().trim() || 'Documento';
      righe.push({
        tipo: 'documento',
        data: d.datadoc,
        doc: `${d.tipodoc}·${d.numdoc || d.iddoc}`,
        descrizione: descr,
        dare, avere,
        _ord: 1,
        _iddoc: d.iddoc,
        _tipodoc: d.tipodoc
      });
    });

    pags.forEach(p => {
      const importo = p.importo || 0;
      let dare = 0, avere = 0;
      // In Danea TPrimaNota: pagamenti a fornitore hanno Importo NEGATIVO (outflow),
      // incassi da cliente hanno Importo POSITIVO (inflow).
      // Per dare/avere usiamo il valore assoluto nel verso corretto:
      //   fornitore: pagamento (importo<0) → DARE (riduce debito)
      //              rimborso  (importo>0) → AVERE (aumenta debito, raro)
      //   cliente:   incasso   (importo>0) → AVERE (riduce credito)
      //              rimborso  (importo<0) → DARE  (aumenta credito, raro)
      if (isFornitore) {
        if (importo <= 0) dare  = -importo;  // pagamento → DARE (+)
        else              avere =  importo;  // rimborso raro → AVERE
      } else {
        if (importo >= 0) avere =  importo;  // incasso → AVERE (+)
        else              dare  = -importo;  // rimborso raro → DARE
      }
      const parts = [];
      if (p.categpagamento) parts.push(p.categpagamento.trim());
      if (p.risorsa) parts.push(p.risorsa.trim());
      if (p.rifpagam) parts.push(p.rifpagam.trim());
      let descr = parts.filter(Boolean).join(' · ');
      if (p.doc_numdoc) descr += ` (rif ${p.doc_tipodoc}·${p.doc_numdoc})`;
      const rataInfo = p.nomepagamdoc ? ` [${p.nomepagamdoc.trim()}]` : '';
      righe.push({
        tipo: 'pagamento',
        data: p.datapagam,
        doc: (p.rifpagam || 'Pagam.').trim() + rataInfo,
        descrizione: descr || 'Pagamento',
        dare, avere,
        _ord: 2,
        _idprimanota: p.idprimanota,
        _iddoc_rif: p.iddoc
      });
    });

    righe.sort((a, b) => {
      const da = new Date(a.data).getTime();
      const db = new Date(b.data).getTime();
      if (da !== db) return da - db;
      return a._ord - b._ord;
    });

    // Saldo progressivo: convention contabile dare-avere (Merkaba / mastrino AGO).
    //   CLIENTI   (attivo):  saldo positivo = credito aperto verso cliente
    //   FORNITORI (passivo): saldo negativo = debito aperto verso fornitore
    let saldo = 0, totDare = 0, totAvere = 0;
    righe.forEach(r => {
      totDare += r.dare;
      totAvere += r.avere;
      saldo += r.dare - r.avere;
      r.saldo = saldo;
      delete r._ord;
    });

    // Anticipi imputati (matching per soggetto). Il JSON da guardare dipende dal ruolo:
    //  - ruolo clienti   → anticipi_clienti.json   (campo "cliente")
    //  - ruolo fornitori → anticipi_fornitori.json (campo "fornitore")
    let anticipiImputati = [];
    try {
      const tipoAnti = isFornitore ? 'fornitori' : 'clienti';
      const soggKey  = ANTICIPI_SOGG_KEY[tipoAnti];          // 'cliente' | 'fornitore'
      const antiData = _anticipiLoad(tipoAnti);
      const nome = (a.nome || '').toUpperCase();
      const codanagr = (a.codanagr || '').toUpperCase().trim();
      const primaParola = nome.split(/\s+/)[0] || '';
      anticipiImputati = antiData.anticipi.filter(an => {
        if (!an.spostato) return false;
        const target  = (an.cli_for_target || '').toUpperCase();
        const soggOrig = (an[soggKey] || an.cliente || an.fornitore || '').toUpperCase();
        // Match se:
        //  - target contiene codanagr Danea
        //  - target/soggetto_originale contiene il nome o prima parola
        //  - nome anagrafica Danea contiene il soggetto dell'anticipo originale
        if (codanagr && target.includes(codanagr)) return true;
        if (primaParola.length >= 3 && (target.includes(primaParola) || soggOrig.includes(primaParola))) return true;
        if (nome.includes(soggOrig) || (soggOrig && soggOrig.length >= 3 && nome.includes(soggOrig))) return true;
        return false;
      });
    } catch {}

    const totImputati = anticipiImputati.reduce((s, x) => s + (x.importo || 0), 0);

    res.json({
      anagrafica: {
        idanagr: id,
        codanagr: (a.codanagr || '').trim(),
        nome: (a.nome || '').trim(),
        cliente: a.cliente === 1,
        fornitore: a.fornitore === 1,
        citta: a.citta, nazione: a.nazione,
        partitaiva: a.partitaiva, codicefiscale: a.codicefiscale
      },
      from: fromIso,
      al: alIso,
      ruolo_usato: isFornitore ? 'fornitori' : 'clienti',
      ruolo_richiesto: ruoloReq || '(auto)',
      tipodoc_filtro: tipoDocAll ? '(tutti — bypass)' : tipiDoc.join(','),
      // saldo_iniziale: convention PDF AGO (positivo=credito per clienti / debito per fornitori).
      // saldo_iniziale_dare_avere: convention contabile dare-avere (positivo=credito cliente, negativo=debito fornitore).
      saldo_iniziale: saldoIniziale,
      saldo_iniziale_dare_avere: isFornitore ? -saldoIniziale : saldoIniziale,
      saldo_iniziale_source: {
        fonte: 'PDF bilancio 31/12/2025 (saldi_iniziali_2026.json)',
        meta: _saldiInizialiMeta(),
        match_type: siLookup.match_type,           // 'exact' | 'partial' | 'none'
        nome_normalizzato: siLookup.nome_norm,
        entries: siLookup.entries                  // [{ nome, sottoconto, sottoconto_desc, saldo, da }, ...]
      },
      totali: {
        saldo_iniziale: saldoIniziale,             // convention PDF
        dare: totDare,
        avere: totAvere,
        saldo: totDare - totAvere,                 // convention dare-avere (fornitore: neg=debito)
        anticipi_imputati: totImputati
      },
      righe,
      anticipi_imputati: anticipiImputati
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ─── DANEA DEBUG per singola anagrafica (per capire divergenze Merkaba) ─────
// ═════════════════════════════════════════════════════════════════════════════
// Accetta id=<idanagr> oppure q=<parte_nome> oppure codanagr=<codice>
// GET /api/danea-debug/anagrafica?q=Abbott&from=2025-01-01
app.get('/api/danea-debug/anagrafica', async (req, res) => {
  try {
    const fromIso = _isoFrom(req.query.from);
    let where = null;
    if (req.query.id) {
      where = `"IDAnagr" = ${parseInt(req.query.id, 10) || 0}`;
    } else if (req.query.codanagr) {
      const c = String(req.query.codanagr).replace(/'/g, "''");
      where = `UPPER("CodAnagr") = UPPER('${c}')`;
    } else if (req.query.q) {
      const q = String(req.query.q).replace(/'/g, "''").toUpperCase();
      where = `UPPER("Nome") LIKE '%${q}%'`;
    } else {
      return res.status(400).json({ error: 'fornire id, codanagr o q' });
    }

    const anagrafiche = await query(`SELECT * FROM "TAnagrafica" WHERE ${where}`);
    if (!anagrafiche.length) return res.json({ from: fromIso, anagrafiche: [], hint: 'nessuna anagrafica trovata' });

    const out = [];
    for (const a of anagrafiche) {
      const id = a.idanagr;

      // A) Tutti i documenti di questa anagrafica, split per TipoDoc + segno TotDoc + pre/post cutoff
      const docsBreak = await query(`
        SELECT "TipoDoc" AS tipodoc,
               CASE WHEN "DataDoc" < '${fromIso}' THEN 'pre' ELSE 'post' END AS periodo,
               CASE WHEN "TotDoc" > 0 THEN 'pos' WHEN "TotDoc" < 0 THEN 'neg' ELSE 'zero' END AS segno,
               COUNT(*) AS n,
               SUM("TotDoc") AS somma_totdoc,
               MIN("DataDoc") AS min_data,
               MAX("DataDoc") AS max_data
        FROM "TDocTestate"
        WHERE "IDAnagr" = ${id}
        GROUP BY "TipoDoc",
                 CASE WHEN "DataDoc" < '${fromIso}' THEN 'pre' ELSE 'post' END,
                 CASE WHEN "TotDoc" > 0 THEN 'pos' WHEN "TotDoc" < 0 THEN 'neg' ELSE 'zero' END
        ORDER BY "TipoDoc", 2, 3
      `);

      // B) Tutti i pagamenti di questa anagrafica
      const pagsBreak = await query(`
        SELECT CASE WHEN "DataPagam" IS NULL THEN 'null'
                    WHEN "DataPagam" < '${fromIso}' THEN 'pre' ELSE 'post' END AS periodo,
               "Saldato" AS saldato,
               "IsAcconto" AS isacconto,
               CASE WHEN "IDGiroconto" IS NULL OR "IDGiroconto" = 0 THEN 'no_gir' ELSE 'si_gir' END AS gir,
               CASE WHEN "IDDoc" IS NULL OR "IDDoc" = 0 THEN 'no_doc' ELSE 'si_doc' END AS haveDoc,
               COUNT(*) AS n,
               SUM("Importo") AS somma_importo
        FROM "TPrimaNota"
        WHERE "IDAnagr" = ${id}
        GROUP BY CASE WHEN "DataPagam" IS NULL THEN 'null'
                      WHEN "DataPagam" < '${fromIso}' THEN 'pre' ELSE 'post' END,
                 "Saldato", "IsAcconto",
                 CASE WHEN "IDGiroconto" IS NULL OR "IDGiroconto" = 0 THEN 'no_gir' ELSE 'si_gir' END,
                 CASE WHEN "IDDoc" IS NULL OR "IDDoc" = 0 THEN 'no_doc' ELSE 'si_doc' END
        ORDER BY 1, 2, 3, 4, 5
      `);

      // C) Campioni di doc nel periodo post (primi 15)
      const docsSample = await query(`
        SELECT FIRST 15 "IDDoc" AS iddoc, "TipoDoc" AS tipodoc, "DataDoc" AS datadoc,
               "NumDoc" AS numdoc, "TotDoc" AS totdoc,
               "Pagam_Saldato" AS pagam_saldato,
               "Pagam_ImportoSaldato" AS pag_saldato,
               "Pagam_ImportoDaSaldare" AS pag_da_saldare
        FROM "TDocTestate"
        WHERE "IDAnagr" = ${id} AND "DataDoc" >= '${fromIso}'
        ORDER BY "DataDoc"
      `);

      // D) Campioni di pag nel periodo post (primi 15)
      const pagsSample = await query(`
        SELECT FIRST 15 "IDPrimaNota" AS idprimanota, "IDDoc" AS iddoc,
               "DataPagam" AS datapagam, "Importo" AS importo,
               "Saldato" AS saldato, "IsAcconto" AS isacconto,
               "IDGiroconto" AS idgiroconto,
               "RifPagam" AS rifpagam
        FROM "TPrimaNota"
        WHERE "IDAnagr" = ${id} AND "DataPagam" >= '${fromIso}'
        ORDER BY "DataPagam"
      `);

      // E) Ricalcolo "come fa la LISTA" (filtro F,N,I,E) vs "come fa il DETAIL" (F,N o I,E)
      const isFornitore = a.fornitore === 1;
      const tipiDetail = isFornitore ? DANEA_TIPODOC_FORNITORI : DANEA_TIPODOC_CLIENTI;
      const tipiAll = ['F','N','I','E'];
      const listaCalc = await query(`
        SELECT SUM(CASE WHEN "TotDoc" > 0 AND "DataDoc" < '${fromIso}' THEN "TotDoc" ELSE 0 END) AS pre_pos,
               SUM(CASE WHEN "TotDoc" < 0 AND "DataDoc" < '${fromIso}' THEN -"TotDoc" ELSE 0 END) AS pre_neg,
               SUM(CASE WHEN "TotDoc" > 0 AND "DataDoc" >= '${fromIso}' THEN "TotDoc" ELSE 0 END) AS post_pos,
               SUM(CASE WHEN "TotDoc" < 0 AND "DataDoc" >= '${fromIso}' THEN -"TotDoc" ELSE 0 END) AS post_neg
        FROM "TDocTestate"
        WHERE "IDAnagr" = ${id} AND "TipoDoc" IN (${tipiAll.map(t=>`'${t}'`).join(',')})
      `);
      const detailCalc = await query(`
        SELECT SUM(CASE WHEN "TotDoc" > 0 AND "DataDoc" < '${fromIso}' THEN "TotDoc" ELSE 0 END) AS pre_pos,
               SUM(CASE WHEN "TotDoc" < 0 AND "DataDoc" < '${fromIso}' THEN -"TotDoc" ELSE 0 END) AS pre_neg,
               SUM(CASE WHEN "TotDoc" > 0 AND "DataDoc" >= '${fromIso}' THEN "TotDoc" ELSE 0 END) AS post_pos,
               SUM(CASE WHEN "TotDoc" < 0 AND "DataDoc" >= '${fromIso}' THEN -"TotDoc" ELSE 0 END) AS post_neg
        FROM "TDocTestate"
        WHERE "IDAnagr" = ${id} AND "TipoDoc" IN (${tipiDetail.map(t=>`'${t}'`).join(',')})
      `);

      out.push({
        idanagr: id,
        codanagr: (a.codanagr || '').trim(),
        nome: (a.nome || '').trim(),
        cliente: a.cliente === 1,
        fornitore: a.fornitore === 1,
        from: fromIso,
        docs_breakdown: docsBreak,
        pags_breakdown: pagsBreak,
        docs_sample_post: docsSample,
        pags_sample_post: pagsSample,
        calc_come_lista_F_N_I_E: listaCalc[0],
        calc_come_detail: detailCalc[0],
        tipi_doc_detail_usati: tipiDetail,
        nota: isFornitore
          ? 'Anagrafica trattata come FORNITORE (fornitore=1). TipoDoc usati in detail: I,E'
          : 'Anagrafica trattata come CLIENTE. TipoDoc usati in detail: F,N'
      });
    }

    res.json({ from: fromIso, trovate: out.length, anagrafiche: out });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ─── DANEA EXPLORE (temporaneo: per capire struttura DB) ─────────────────────
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/danea-explore', async (req, res) => {
  try {
    // Q1: Tipi di documento
    const q1 = await query(`
      SELECT "TipoDoc", COUNT(*) AS n, MIN("DataDoc") AS dal, MAX("DataDoc") AS al
      FROM "TDocTestate"
      GROUP BY "TipoDoc"
      ORDER BY COUNT(*) DESC
    `);

    // Q2: Esempio anagrafica AME (per capire le colonne)
    const q2 = await query(`
      SELECT FIRST 3 * FROM "TAnagrafica"
      WHERE UPPER("Nome") LIKE '%AME ADVANCED%'
    `);
    const q2cols = q2.length ? Object.keys(q2[0]) : [];

    // Q3: Pagamenti con/senza IDDoc
    const q3 = await query(`
      SELECT
        CASE WHEN "IDDoc" IS NULL OR "IDDoc" = 0 THEN 'senza_doc' ELSE 'con_doc' END AS tipo,
        COUNT(*) AS n,
        SUM("Importo") AS tot
      FROM "TPrimaNota"
      GROUP BY 1
    `);

    // Q4 bonus: prime 2 righe TPrimaNota di AME (per vedere le colonne)
    let q4 = [];
    let q4cols = [];
    if (q2.length) {
      const idAnagrAme = q2[0].idanagr || q2[0].IDAnagr;
      if (idAnagrAme) {
        q4 = await query(`SELECT FIRST 2 * FROM "TPrimaNota" WHERE "IDAnagr" = ${parseInt(idAnagrAme,10)}`);
        q4cols = q4.length ? Object.keys(q4[0]) : [];
      }
    }

    // Q5 bonus: prime 2 righe TDocTestate di AME (per vedere le colonne)
    let q5 = [];
    let q5cols = [];
    if (q2.length) {
      const idAnagrAme = q2[0].idanagr || q2[0].IDAnagr;
      if (idAnagrAme) {
        q5 = await query(`SELECT FIRST 2 * FROM "TDocTestate" WHERE "IDAnagr" = ${parseInt(idAnagrAme,10)}`);
        q5cols = q5.length ? Object.keys(q5[0]) : [];
      }
    }

    res.json({
      q1_tipi_doc: q1,
      q2_anagrafica_ame: q2,
      q2_colonne_tanagrafica: q2cols,
      q3_pagam_con_senza_doc: q3,
      q4_esempio_tprimanota_ame: q4,
      q4_colonne_tprimanota: q4cols,
      q5_esempio_tdoctestate_ame: q5,
      q5_colonne_tdoctestate: q5cols
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ─── DIAGNOSTICA: TipoDoc reali per fornitori ────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
// Obiettivo: verificare che i codici TipoDoc Easyfatt per le FATTURE ACQUISTO
// in DANEA_TIPODOC_FORNITORI siano coerenti col DB reale. Verificato aprile 2026:
// sono 'U' (Fattura forn., 315 doc/€1,18M dal cutoff) e 'N' (NC raro).
//
// Uso tipico:
//   curl http://172.17.2.100:8087/api/debug/fornitori-tipodoc
//   curl http://172.17.2.100:8087/api/debug/fornitori-tipodoc?nome=ALLIS
//
// Q1 → distribuzione TipoDoc per TUTTE le anagrafiche Fornitore=1 (global)
// Q2 → distribuzione TipoDoc per documenti >= 2026-01-01 su anagrafiche Fornitore=1
// Q3 → se ?nome=xxx, dettaglio documenti di un fornitore specifico (>=2026-01-01)
// Q4 → sample di 10 documenti "TipoDoc unusual" (fuori dalla costante attuale)
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/debug/fornitori-tipodoc', async (req, res) => {
  try {
    const nomeFiltro = (req.query.nome || '').trim().toUpperCase();
    const cutoff = DANEA_CUTOFF;

    // Q1: distribuzione TipoDoc su anagrafiche Fornitore=1 (TUTTI i periodi)
    const q1 = await query(`
      SELECT d."TipoDoc" AS tipodoc,
             COUNT(*) AS n,
             MIN(d."DataDoc") AS dal,
             MAX(d."DataDoc") AS al,
             SUM(d."TotDoc") AS tot_importo
      FROM "TDocTestate" d
      JOIN "TAnagrafica" a ON a."IDAnagr" = d."IDAnagr"
      WHERE a."Fornitore" = 1
      GROUP BY d."TipoDoc"
      ORDER BY COUNT(*) DESC
    `);

    // Q2: distribuzione TipoDoc >= cutoff su anagrafiche Fornitore=1
    const q2 = await query(`
      SELECT d."TipoDoc" AS tipodoc,
             COUNT(*) AS n,
             SUM(d."TotDoc") AS tot_importo,
             MIN(d."DataDoc") AS dal,
             MAX(d."DataDoc") AS al
      FROM "TDocTestate" d
      JOIN "TAnagrafica" a ON a."IDAnagr" = d."IDAnagr"
      WHERE a."Fornitore" = 1
        AND d."DataDoc" >= '${cutoff}'
      GROUP BY d."TipoDoc"
      ORDER BY COUNT(*) DESC
    `);

    // Q3 (se ?nome=): documenti di un fornitore specifico >= cutoff
    let q3 = [];
    let q3_anagrafiche = [];
    if (nomeFiltro) {
      q3_anagrafiche = await query(`
        SELECT "IDAnagr" AS idanagr, "CodAnagr" AS codanagr, "Nome" AS nome,
               "Cliente" AS cliente, "Fornitore" AS fornitore
        FROM "TAnagrafica"
        WHERE UPPER("Nome") LIKE '%${nomeFiltro.replace(/'/g, "''")}%'
      `);
      if (q3_anagrafiche.length) {
        const ids = q3_anagrafiche.map(a => parseInt(a.idanagr, 10)).filter(Boolean).join(',');
        q3 = await query(`
          SELECT "IDAnagr" AS idanagr, "IDDoc" AS iddoc,
                 "TipoDoc" AS tipodoc, "DataDoc" AS datadoc,
                 "NumDoc" AS numdoc, "DescDoc" AS descdoc,
                 "TotDoc" AS totdoc, "NomeReport" AS nomereport
          FROM "TDocTestate"
          WHERE "IDAnagr" IN (${ids})
            AND "DataDoc" >= '${cutoff}'
          ORDER BY "DataDoc"
        `);
      }
    }

    // Q4: sample 10 documenti post-cutoff con TipoDoc "unusual" (fuori dalle costanti)
    const noti = Array.from(new Set([...DANEA_TIPODOC_CLIENTI, ...DANEA_TIPODOC_FORNITORI]));
    const notiClause = noti.map(t => `'${t}'`).join(',');
    const q4 = await query(`
      SELECT FIRST 10
             d."IDAnagr" AS idanagr, a."Nome" AS nome,
             d."TipoDoc" AS tipodoc, d."DataDoc" AS datadoc,
             d."NumDoc" AS numdoc, d."TotDoc" AS totdoc,
             d."DescDoc" AS descdoc, d."NomeReport" AS nomereport,
             a."Cliente" AS cliente, a."Fornitore" AS fornitore
      FROM "TDocTestate" d
      JOIN "TAnagrafica" a ON a."IDAnagr" = d."IDAnagr"
      WHERE a."Fornitore" = 1
        AND d."DataDoc" >= '${cutoff}'
        AND d."TipoDoc" NOT IN (${notiClause})
    `);

    res.json({
      cutoff,
      filtro_costanti_attuale: DANEA_TIPODOC_FORNITORI,
      q1_tipodoc_fornitori_all_periods: q1,
      q2_tipodoc_fornitori_dal_cutoff: q2,
      q3_filtro_nome: nomeFiltro || null,
      q3_anagrafiche_trovate: q3_anagrafiche,
      q3_documenti: q3,
      q4_sample_tipodoc_fuori_costante: q4,
      hint: 'Confronta q2: se vedi codici NON in filtro_costanti_attuale, aggiungili a DANEA_TIPODOC_FORNITORI in server.js.'
    });
  } catch (e) {
    console.error('Errore /api/debug/fornitori-tipodoc:', e.message);
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// ─── RID AUTOMATICI ──────────────────────────────────────────────────────────
const RID_DEFAULT = [
  { id:'rid1',  frequenza:'Fine Mese',  descrizione:'Finanziamento 84 mesi MCC 27/02/18 — scad. 31/12/26', banca:'BDM', importo:2663 },
  { id:'rid2',  frequenza:'Fine Mese',  descrizione:'Finanziamento 72 mesi MCC 15/09/20 — scad. 30/09/26', banca:'BDM', importo:4678 },
  { id:'rid3',  frequenza:'Fine Mese',  descrizione:'Leasing Tesla — FCA Bank',                             banca:'BDM', importo:533  },
  { id:'rid4',  frequenza:'Fine Mese',  descrizione:'Noleggio Toyota Yaris — ALD Automotive',              banca:'BDM', importo:449  },
  { id:'rid5',  frequenza:'Trimestrale',descrizione:'Affitto — Oznerol SRL',                               banca:'',    importo:29280},
  { id:'rid6',  frequenza:'Trimestrale',descrizione:'Muletto — Oznerol SRL',                               banca:'',    importo:10370},
  { id:'rid7',  frequenza:'21/12/26',   descrizione:'Assicurazione Tesla GB811GT — Telepass Assicurazione',banca:'',    importo:270  },
  { id:'rid8',  frequenza:'28/05/26',   descrizione:'Assicurazione Tesla GN814VY — AXA',                   banca:'',    importo:513  },
  { id:'rid9',  frequenza:'31/12/26',   descrizione:'Assicurazione Capannone Oznerol — Busnelli/Zurich',   banca:'',    importo:868  },
  { id:'rid10', frequenza:'02/04/26',   descrizione:'Assicurazione Incendio/Furto Capannone RCT AEC — Busnelli/Zurich', banca:'', importo:2651 }
];

app.get('/api/rid', (req, res) => {
  const data = loadData();
  res.json({ voci: data.rid_voci && data.rid_voci.length ? data.rid_voci : RID_DEFAULT });
});

app.post('/api/rid', (req, res) => {
  try {
    const { voci } = req.body;
    if (!Array.isArray(voci)) return res.status(400).json({ error: 'voci[] required' });
    const data = loadData();
    data.rid_voci = voci;
    saveData(data);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// INTRASTAT — generatore scambi.cee per Intr@Web (cessioni intra-UE INTRA 1-bis)
// Logica core in ./intrastat/  (cee.js, match.js, parsers.js)
// Anagrafica clienti cachata in ./intrastat_anagrafica.json
// ─────────────────────────────────────────────────────────────────────────────
const multer = require('multer');
const intraParsers = require('./intrastat/parsers');
const intraMatch = require('./intrastat/match');
const intraCee = require('./intrastat/cee');

const INTRA_ANAGRAFICA = path.join(__dirname, 'intrastat_anagrafica.json');
const INTRA_PIVA_DICHIARANTE = process.env.PIVA_DICHIARANTE || '12520320156';
const intraUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

function intraLoadAnagrafica() {
  if (!fs.existsSync(INTRA_ANAGRAFICA)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(INTRA_ANAGRAFICA, 'utf8'));
    raw.customers.forEach(c => { c._norm = intraMatch.normalize(c.denominazione); });
    return raw;
  } catch (e) {
    console.error('[Intrastat] errore lettura cache anagrafica:', e);
    return null;
  }
}

app.get('/api/intrastat/anagrafica/info', (req, res) => {
  const a = intraLoadAnagrafica();
  if (!a) return res.json({ presente: false });
  res.json({ presente: true, count: a.customers.length, aggiornata: a.aggiornata, nomeFile: a.nomeFile });
});

app.post('/api/intrastat/anagrafica', intraUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File mancante' });
    const customers = await intraParsers.parseAnagrafica(req.file.buffer);
    const payload = {
      aggiornata: new Date().toISOString(),
      nomeFile: req.file.originalname,
      customers: customers.map(({ _norm, ...c }) => c),
    };
    fs.writeFileSync(INTRA_ANAGRAFICA, JSON.stringify(payload, null, 2));
    res.json({ ok: true, count: customers.length });
  } catch (e) {
    console.error('[Intrastat] anagrafica error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/intrastat/quadratura',
  intraUpload.fields([{ name: 'vendite', maxCount: 1 }, { name: 'pdf', maxCount: 1 }]),
  async (req, res) => {
    try {
      const anagrafica = intraLoadAnagrafica();
      if (!anagrafica) return res.status(400).json({ error: 'Anagrafica clienti non caricata. Caricala prima.' });
      if (!req.files?.vendite?.[0]) return res.status(400).json({ error: 'File analisi vendite mancante' });

      const vendite = await intraParsers.parseVendite(req.files.vendite[0].buffer);
      let commercialista = [];
      if (req.files?.pdf?.[0]) {
        try { commercialista = await intraParsers.parseCommercialistaPdf(req.files.pdf[0].buffer); }
        catch (e) { console.warn('[Intrastat] PDF non leggibile:', e.message); }
      }
      const commByPiva = new Map(commercialista.map(c => [c.piva, c]));

      const righe = [];
      const noMatch = [];
      for (const v of vendite) {
        const m = intraMatch.findCustomer(v.denominazione, anagrafica.customers);
        if (!m) { noMatch.push({ denominazione: v.denominazione, importo: v.importo }); continue; }
        const c = m.customer;
        const danea = +v.importo.toFixed(2);
        const comm = commByPiva.get(c.piva)?.importo;
        const diff = comm != null ? +(danea - comm).toFixed(2) : null;
        righe.push({
          piva: c.piva, denominazione: c.denominazione, nazione: c.nazione,
          importoDanea: danea, importoCommercialista: comm ?? null, diff,
          importoFinale: comm != null ? comm : danea,
          matchStrategy: m.strategy, matchConfidence: m.confidence,
        });
      }
      righe.sort((a, b) => a.piva.localeCompare(b.piva));

      const pivasMatched = new Set(righe.map(r => r.piva));
      const soloComm = commercialista
        .filter(c => !pivasMatched.has(c.piva))
        .map(c => ({ piva: c.piva, denominazione: c.denominazione, importo: c.importo }));

      res.json({
        righe, noMatch, soloComm,
        totaleDanea: +(righe.reduce((s, r) => s + r.importoDanea, 0)
          + noMatch.reduce((s, r) => s + r.importo, 0)).toFixed(2),
        totaleCommercialista: commercialista.length
          ? +commercialista.reduce((s, c) => s + c.importo, 0).toFixed(2) : null,
        commercialistaCaricato: commercialista.length > 0,
      });
    } catch (e) {
      console.error('[Intrastat] quadratura error:', e);
      res.status(500).json({ error: e.message });
    }
  }
);

app.post('/api/intrastat/genera', (req, res) => {
  try {
    const { anno, mese, righe } = req.body || {};
    if (!anno || !mese || !Array.isArray(righe) || righe.length === 0) {
      return res.status(400).json({ error: 'Parametri mancanti (anno, mese, righe)' });
    }
    for (const r of righe) {
      if (!/^[A-Z]{2}[A-Z0-9]+$/i.test(r.piva || '')) return res.status(400).json({ error: `P.IVA non valida: "${r.piva}"` });
      if (typeof r.importo !== 'number' || r.importo <= 0) return res.status(400).json({ error: `Importo non valido per ${r.piva}: ${r.importo}` });
    }
    const cee = intraCee.generaScambiCee({
      pivaDichiarante: INTRA_PIVA_DICHIARANTE,
      anno: Number(anno), mese: Number(mese),
      righe: righe.map(r => ({ piva: r.piva.toUpperCase(), importo: Number(r.importo) })),
    });
    res.setHeader('Content-Type', 'text/plain; charset=ISO-8859-1');
    res.setHeader('Content-Disposition', 'attachment; filename="scambi.cee"');
    res.send(Buffer.from(cee, 'latin1'));
  } catch (e) {
    console.error('[Intrastat] genera error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

const PORT = 8087;
console.log(`[AEC Cash] Tentativo bind porta ${PORT}...`);
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nAEC Cashflow Server avviato su http://0.0.0.0:${PORT}`);
  console.log(`   Rete locale: http://172.17.2.100:${PORT}\n`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[ERRORE] Porta ${PORT} già in uso! Chiudi il vecchio processo node.exe e riprova.\n`);
  } else {
    console.error(`\n[ERRORE] Listen fallito: ${err.message}\n`);
  }
  process.exit(1);
});
