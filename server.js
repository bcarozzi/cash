console.log('[AEC Cash] Avvio in corso...');
const express = require('express');
const Firebird = require('node-firebird');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
console.log('[AEC Cash] Moduli caricati OK');

// ─── FATTURA ELETTRONICA API ──────────────────────────────────────────────────
const FETAPI_BASE  = 'fattura-elettronica-api.it';
const FETAPI_PATH  = '/ws2.0/prod';
const FETAPI_AUTH  = Buffer.from('bcarozzi@gmail.com:QBlGQVGG').toString('base64');
const _fetApiCache = {}; // NomeFile (senza ext) → ID API

function fetApiGet(subpath) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: FETAPI_BASE,
      path: FETAPI_PATH + subpath,
      headers: { 'Authorization': 'Basic ' + FETAPI_AUTH }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

const app = express();
app.use(cors());
app.use(express.json());
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
  return dt.toISOString().slice(0,10);
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

    // Escludi pagamenti già saldati nel tracking locale AEC Cash
    const vociFiltrate = voci.filter(v => !wiseSaldati[String(v.id)]);

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

  // Pagamento immediato
  if (!str || str.includes('vista') || str.includes('advance') || str.includes('anticipo') || str.includes('subito') || str.includes('immediat')) {
    return [{ scadenza: new Date(dataDoc).toISOString().slice(0,10), quota: 1 }];
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
app.get('/api/fatture-sdi', async (req, res) => {
  try {
    const data = loadData();
    const sdiSaldati  = data.sdi_saldati  || {};
    const sdiScadenze = data.sdi_scadenze || {};

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

    // Query 2: anagrafica fornitori per leggere PagamentoDefault e IBAN
    const pagMap  = {};
    const ibanMap = {};
    const ibanRegex = /[A-Z]{2}\d{2}[A-Z0-9 ]{11,30}/;
    const sdiIbanManuali = data.sdi_iban_manuali || {};
    const sdiNote        = data.sdi_note        || {};
    try {
      const anRows = await query(`SELECT * FROM "TAnagrafica"`);
      anRows.forEach(r => {
        // Includi solo fornitori (campo Fornitore: 'S', 1, true — accetta qualsiasi valore truthy)
        const isFornitore = r.fornitore == 1 || r.fornitore === 'S' || r.fornitore === true;
        if (!isFornitore) return;
        const pag      = r.pagamentodefault || null;
        const coordRaw = (r.coordbancariedefault || '').trim();
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

    const fatture = [];
    rows.filter(r => !sdiSaldati[r.idagyo]).forEach(r => {
      const dataDoc       = r.datadoc ? new Date(r.datadoc) : null;
      const importoTot    = Math.abs(Number(r.totdovuto) || 0);
      const cf            = (r.codicefiscale || '').trim();
      const piva          = (r.partitaiva || '').trim();
      const pagamento     = pagMap[cf] || pagMap[piva] || null;
      const rate          = calcolaRateDaPagamento(dataDoc, pagamento);
      const nRate         = rate.length;

      rate.forEach((rata, idx) => {
        const rataId       = nRate > 1 ? `${r.idagyo}_r${idx+1}` : r.idagyo;
        const scadOverride = sdiScadenze[rataId] || null;
        const nomeL = (r.nome || '').toLowerCase();
        const isAddebitoDiretto = FORNITORI_ADDEBITO_DIRETTO.some(p => nomeL.includes(p.toLowerCase()));
        fatture.push({
          id:              rataId,
          id_agyo:         r.idagyo,
          rata_n:          nRate > 1 ? `${idx+1}/${nRate}` : null,
          nome:            (r.nome || '').trim(),
          cf:              cf,
          numdoc:          (r.numdoc || '').trim(),
          tipodoc:         (r.tipodocfe || '').trim(),
          data_doc:        dataDoc ? dataDoc.toISOString().slice(0,10) : null,
          data_ricezione:  r.dataricezione ? new Date(r.dataricezione).toISOString().slice(0,10) : null,
          pagamento_desc:  (pagamento || '').trim(),
          scadenza:        scadOverride || rata.scadenza || null,
          scadenza_manual: !!scadOverride,
          importo:         Math.round(importoTot * rata.quota * 100) / 100,
          iban:            ibanMap[cf] || ibanMap[piva] || null,
          iban_manuale:    sdiIbanManuali[cf] || sdiIbanManuali[piva] || null,
          note:            sdiNote[rataId] || '',
          addebito_diretto: isAddebitoDiretto
        });
      });
    });

    res.json({ fatture, totale: fatture.reduce((s, f) => s + f.importo, 0) });
  } catch(e) { res.status(500).json({ error: e.message, stack: e.stack }); }
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

/// ─── FATTURE SDI: storico pagamenti ──────────────────────────────────────────
app.get('/api/fatture-sdi/storico', (req, res) => {
  const data = loadData();
  const commenti = data.storico_commenti || {};
  res.json({ storico: (data.sdi_storico || []).slice().reverse().map(b => ({...b, commento: commenti[b.batch_id] || ''})) });
});

// ─── FATTURE SDI: visualizza PDF da fattura-elettronica-api.it ───────────────
app.get('/api/fatture-sdi/pdf/:idagyo', async (req, res) => {
  try {
    const idagyo = parseInt(req.params.idagyo, 10);
    if (isNaN(idagyo)) return res.status(400).json({ error: 'idagyo non valido' });

    // 1. Leggi NomeFile da TAgyo
    let rows;
    try {
      rows = await query(`SELECT "NomeFile" FROM "TAgyo" WHERE "IDAgyo" = ${idagyo}`);
    } catch(e) { return res.status(500).json({ error: 'Query TAgyo: ' + e.message }); }
    if (!rows.length) return res.status(404).json({ error: 'Fattura non trovata in TAgyo' });
    const nomefileRaw = (rows[0].nomefile || '').trim();
    const nomefile = nomefileRaw.replace(/\.(p7m|xml)$/i, '');
    if (!nomefile) return res.status(404).json({ error: 'NomeFile vuoto in TAgyo' });

    // 2. Trova ID API (con cache in memoria — non spreca credito)
    if (!_fetApiCache[nomefile]) {
      const listResp = await fetApiGet('/fatture?per_page=1000');
      if (listResp.status !== 200) {
        const msg = listResp.body.toString('utf8').slice(0, 200);
        return res.status(502).json({ error: `API lista HTTP ${listResp.status}: ${msg}` });
      }
      let lista;
      try { lista = JSON.parse(listResp.body.toString('utf8')); } catch(e) {
        return res.status(502).json({ error: 'Risposta API non JSON' });
      }
      if (!Array.isArray(lista)) lista = lista.fatture || lista.data || lista.results || [];
      // Popola cache per tutte le fatture ricevute
      lista.forEach(f => {
        const k = (f.sdi_nome_file || '').replace(/\.(p7m|xml)$/i, '');
        if (k && f.id) _fetApiCache[k] = f.id;
      });
    }

    const apiId = _fetApiCache[nomefile];
    if (!apiId) return res.status(404).json({ error: `Fattura "${nomefile}" non trovata sull'API fattura-elettronica-api.it` });

    // 3. Scarica PDF e proxy al browser
    const pdfResp = await fetApiGet(`/fatture/${apiId}/pdf`);
    if (pdfResp.status !== 200) {
      return res.status(502).json({ error: `API PDF HTTP ${pdfResp.status}` });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nomefile}.pdf"`);
    res.send(pdfResp.body);

  } catch(e) {
    console.error('Errore PDF fattura:', e.message);
    res.status(500).json({ error: e.message });
  }
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
      f24w(b,p,f24an(sd,4));f24w(b,p+4,f24an(ca,4));f24w(b,p+8,f24an(ma,17));f24w(b,p+25,f24an(pd,6));f24w(b,p+31,f24nu(pa,6));f24w(b,p+37,f24c15(dC));f24w(b,p+52,f24c15(cC));
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
