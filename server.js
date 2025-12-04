// server.js - Versión C limpia con SOLO asignación individual
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// SERVIR CARPETA PUBLIC
app.use(express.static(path.join(__dirname, "public")));

// 🔥 FIX PARA RENDER: servir index.html explícitamente
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// DB
const DB_PATH = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(DB_PATH);

// crear tablas
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    cards TEXT,
    connected INTEGER DEFAULT 0,
    last_seen INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS pending (
    email TEXT PRIMARY KEY,
    ts INTEGER
  )`);
});

// generar 1 cartón
function generateCard() {
  const ranges = {
    B: [1, 15],
    I: [16, 30],
    N: [31, 45],
    G: [46, 60],
    O: [61, 75]
  };

  const card = {};
  for (const col in ranges) {
    const [min, max] = ranges[col];
    const arr = [];
    while (arr.length < 5) {
      const n = Math.floor(Math.random() * (max - min + 1)) + min;
      if (!arr.includes(n)) arr.push(n);
    }
    card[col] = arr;
  }

  // centro libre
  card.N[2] = "FREE";
  return card;
}

// runtime
let drawnNumbers = new Set();
const emailToSocket = {};
const socketToEmail = {};

// significados
const meanings = {
  1:"El galán",2:"El patito",3:"San Cono",4:"La cama",5:"El gato",6:"El perro",
  7:"El revólver",8:"El incendio",9:"El arroyo",10:"La rosa",11:"El minero",
  12:"El soldado",13:"La yeta",14:"El borracho",15:"La niña bonita",16:"El anillo",
  17:"La desgracia",18:"La sangre",19:"El pescado",20:"La fiesta",21:"La mujer",
  22:"El loco",23:"El cocinero",24:"El caballo",25:"La gallina",26:"La misa",
  27:"El peine",28:"La niña",29:"El jardín",30:"La silla",31:"La bomba",
  32:"El reloj",33:"La cuna",34:"El nene",35:"La cebra",36:"Los pies",
  37:"El loco viejo",38:"La herencia",39:"La pala",40:"El cura",41:"La cucha",
  42:"La zapatilla",43:"El balcón",44:"La cárcel",45:"El vino",46:"El tomate",
  47:"El muerto",48:"El loco malo",49:"La vela",50:"El huevo",51:"La soga",
  52:"La escalera",53:"La teta",54:"El santo",55:"El aire",56:"La carta",
  57:"El maestro",58:"El miedo",59:"El cerro",60:"La virgen",61:"La escopeta",
  62:"La inundación",63:"El casamiento",64:"El llanto",65:"El cazador",
  66:"La lombriz",67:"La víbora",68:"El humo",69:"La copa",70:"El toro",
  71:"La flor",72:"La guitarra",73:"La bomba vieja",74:"El tren",75:"La suerte"
};

// DB helpers
function getUser(email) {
  return new Promise((res, rej) => {
    db.get("SELECT * FROM users WHERE email=?", [email], (err, row) => {
      if (err) rej(err);
      else res(row);
    });
  });
}

function upsertUser(email, cardsArray) {
  return new Promise((res, rej) => {
    const json = JSON.stringify(cardsArray);
    const ts = Date.now();

    db.run(
      `INSERT INTO users(email,cards,connected,last_seen)
       VALUES(?,?,?,?)
       ON CONFLICT(email) DO UPDATE SET cards=excluded.cards, connected=1, last_seen=?`,
      [email, json, 1, ts, ts],
      err => err ? rej(err) : res()
    );
  });
}

function setConnected(email, connected) {
  return new Promise((res, rej) => {
    db.run("UPDATE users SET connected=?, last_seen=? WHERE email=?",
      [connected ? 1 : 0, Date.now(), email],
      err => err ? rej(err) : res()
    );
  });
}

// analizar terna/quintina/bingo
function analyzeCard(cardObj, drawnSet) {
  const cols = ["B","I","N","G","O"];
  const grid = [];

  for (let r=0; r<5; r++){
    const row=[];
    for (let c=0;c<5;c++){
      row.push(cardObj[cols[c]][r]);
    }
    grid.push(row);
  }

  const marked = grid.map(row =>
    row.map(v => v==="FREE" || drawnSet.has(Number(v)))
  );

  let terna=false, quintina=false;

  // filas
  for (let r=0;r<5;r++){
    const c = marked[r].filter(Boolean).length;
    if (c >= 3) terna=true;
    if (c === 5) quintina=true;
  }

  // columnas
  for (let c=0;c<5;c++){
    let s=0;
    for (let r=0;r<5;r++) if (marked[r][c]) s++;
    if (s>=3) terna=true;
    if (s===5) quintina=true;
  }

  // diagonales
  let d1=0,d2=0;
  for (let i=0;i<5;i++){
    if (marked[i][i]) d1++;
    if (marked[i][4-i]) d2++;
  }
  if (d1>=3 || d2>=3) terna=true;
  if (d1===5 || d2===5) quintina=true;

  // bingo total
  let allMarked = true;
  for (let r=0;r<5;r++){
    for (let c=0;c<5;c++){
      if (grid[r][c]!=="FREE" && !drawnSet.has(Number(grid[r][c]))) {
        allMarked=false;
        break;
      }
    }
  }

  return {terna, quintina, bingo: allMarked};
}

// enviar estado a admin y jugadores
function broadcastState() {
  db.all("SELECT email FROM pending ORDER BY ts DESC", (err, pend=[]) => {
    const pending = pend.map(p=>p.email);

    db.all("SELECT email,cards,connected FROM users", (err, rows=[]) => {
      const players = rows.map(u => {
        let cards=[];
        try { cards = JSON.parse(u.cards)||[]; } catch(e){}
        return {
          email: u.email,
          cards,
          connected: !!u.connected
        };
      });

      io.emit("pendingList", pending);
      io.emit("playersList", players);
      io.emit("numbersState", Array.from(drawnNumbers).sort((a,b)=>a-b));
    });
  });
}

// SOCKETS
io.on("connection", socket => {
  console.log("socket", socket.id);

  // asignar email al socket
  socket.on("identify", async email => {
    if (!email) return;
    email = email.toLowerCase();

    emailToSocket[email] = socket.id;
    socketToEmail[socket.id] = email;

    await setConnected(email, true).catch(()=>{});

    const user = await getUser(email).catch(()=>null);
    if (user && user.cards) {
      try {
        socket.emit("cardsAssigned", JSON.parse(user.cards));
      } catch {}
    }

    socket.emit("meanings", meanings);
    broadcastState();
  });

  // login admin
  socket.on("loginAdmin", pass => {
    if (pass === "admin1234") socket.emit("adminOk");
    else socket.emit("adminFail");

    broadcastState();
  });

  // jugador pide entrar
  socket.on("playerJoinRequest", email => {
    email=email.toLowerCase();
    db.run("INSERT OR REPLACE INTO pending(email,ts) VALUES(?,?)",
      [email, Date.now()],
      () => broadcastState()
    );
  });

  // admin acepta
  socket.on("adminAccept", email => {
    email=email.toLowerCase();
    db.run("DELETE FROM pending WHERE email=?", [email], () => {
      db.get("SELECT * FROM users WHERE email=?", [email], (err,row) => {
        if (!row)
          db.run("INSERT INTO users(email,cards,connected,last_seen) VALUES(?,?,?,?)",
            [email, "[]", 0, Date.now()]);

        io.emit("playerAccepted", email);
        broadcastState();
      });
    });
  });

  // admin rechazo
  socket.on("adminReject", email => {
    email=email.toLowerCase();
    db.run("DELETE FROM pending WHERE email=?", [email], () => {
      db.run("DELETE FROM users WHERE email=?", [email], () => {
        io.emit("playerRejected", email);
        broadcastState();
      });
    });
  });

  // *** ASIGNACIÓN INDIVIDUAL ***
  socket.on("adminAssignOne", async ({email, count}) => {
    if (!email) return;

    email=email.toLowerCase();
    count = Number(count)||1;
    if (count<1) count=1;
    if (count>6) count=6;

    const cards=[];
    for (let i=0;i<count;i++) cards.push(generateCard());

    await upsertUser(email, cards).catch(()=>{});

    const sid = emailToSocket[email];
    if (sid && io.sockets.sockets.get(sid)) {
      io.to(sid).emit("cardsAssigned", cards);
    }

    broadcastState();
  });

  // eliminar jugador
  socket.on("adminRemove", email => {
    email=email.toLowerCase();
    db.run("DELETE FROM users WHERE email=?", [email], () => {
      db.run("DELETE FROM pending WHERE email=?", [email], () => {
        const sid=emailToSocket[email];
        if (sid) {
          delete emailToSocket[email];
          delete socketToEmail[sid];
        }
        io.emit("playerRemoved", email);
        broadcastState();
      });
    });
  });

  // iniciar partida
  socket.on("adminStartGame", () => {
    drawnNumbers = new Set();
    io.emit("gameStarted");
    broadcastState();
  });

  // sacar número
  socket.on("adminDrawNumber", () => {
    if (drawnNumbers.size >= 75) return;

    let n;
    do { n = Math.floor(Math.random()*75)+1; }
    while (drawnNumbers.has(n));

    drawnNumbers.add(n);
    io.emit("numberDrawn", n);

    db.all("SELECT email,cards FROM users", (err, rows) => {
      if (!rows) return;
      rows.forEach(r => {
        let cards=[];
        try { cards = JSON.parse(r.cards)||[]; } catch {}
        cards.forEach((card, idx) => {
          const a = analyzeCard(card, drawnNumbers);
          if (a.terna || a.quintina || a.bingo) {
            const notif = {
              email: r.email,
              cardIndex: idx,
              terna: a.terna,
              quintina: a.quintina,
              bingo: a.bingo
            };

            const sid=emailToSocket[r.email];
            if (sid) io.to(sid).emit("notification", notif);

            io.emit("notification", notif);
          }
        });
      });
    });

    broadcastState();
  });

  // reset números
  socket.on("adminResetNumbers", () => {
    drawnNumbers = new Set();
    io.emit("numbersReset");
    broadcastState();
  });

  // jugador canta bingo
  socket.on("playerClaimsBingo", email => {
    io.emit("bingoClaimed", email);
  });

  // admin confirma bingo
  socket.on("adminConfirmBingo", email => {
    io.emit("bingoConfirmed", email);
  });

  // desconexión
  socket.on("disconnect", async () => {
    const email = socketToEmail[socket.id];
    if (email) {
      delete emailToSocket[email];
      delete socketToEmail[socket.id];
      await setConnected(email, false);
    }
    broadcastState();
  });

  broadcastState();
});

// START
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log("Server listening on", PORT)
);
