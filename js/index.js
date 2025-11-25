import express from "express";
import Docker from "dockerode";
import { PassThrough } from "stream";
import { spawn } from "child_process";

const app = express();
const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const PORT = 8451;

// função que retorna uma Promise que resolve após N milissegundos
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// MASTER PASSWORD
const ENV_USER = process.env.UI_USER;
const ENV_PASSWORD = process.env.UI_PASSWORD;

app.use((req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Kopia Admin"');
    return res.status(401).send("Autenticação requerida");
  }

  const base64Credentials = authHeader.split(" ")[1];
  const credentials = Buffer.from(base64Credentials, "base64").toString("ascii");
  const [username, password] = credentials.split(":");

  if (password !== ENV_PASSWORD || username !== ENV_USER) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Kopia Admin"');
    return res.status(401).send("Incorrect credentials");
  }

  next();
});

// Função para executar comandos dentro do container
async function execInContainer(containerName, cmdArray) {
  const container = docker.getContainer(containerName);
  const exec = await container.exec({
    Cmd: cmdArray,
    AttachStdout: true,
    AttachStderr: true
  });

  return new Promise((resolve, reject) => {
    exec.start({ hijack: true, stdin: false }, (err, stream) => {
      if (err) return reject(err);

      const stdout = new PassThrough();
      const stderr = new PassThrough();

      container.modem.demuxStream(stream, stdout, stderr);

      let output = "";

      stdout.on("data", (chunk) => {
        output += chunk.toString("utf8");
      });

      stderr.on("data", (chunk) => {
        console.error(chunk.toString("utf8"));
      });

      stream.on("end", () => {
        resolve(output.replace(/^[\x00-\x1F]+/, "").trim());
      });
    });
  });
}

// Função para criar usuário via expect dinamicamente
function createUser(username, passwd) {
  const expectScript = `
    spawn kopia server user add ${username}
    expect "Enter new password:"
    send "${passwd}\\r"
    expect "Re-enter password for verification:"
    send "${passwd}\\r"
    expect eof
  `;

  const proc = spawn('docker', [
    'exec', '-i', 'kopia-server',
    'expect', '-c', expectScript
  ], { stdio: 'inherit' });

  proc.on('close', (code) => {
    if (code === 0) console.log('Usuário criado com sucesso!');
    else console.error('Erro ao criar usuário, exit code:', code);
  });
}

// Função para remover usuário
async function deleteUser(username) {
  await execInContainer("kopia-server", ["kopia", "server", "user", "remove", username]);
}

// GET principal - lista usuários e adiciona linha vazia
app.get("/", async (req, res) => {
  try {
    const usersOutput = await execInContainer(
      "kopia-server",
      ["kopia", "server", "user", "list", "--json"]
    );

    let users = [];
    try {
      users = JSON.parse(usersOutput);
    } catch (err) {
      console.error("Erro ao parsear JSON:", err, "\nRaw output:", usersOutput);
    }

    // Monta tabela
    let htmlTable = "<table border='1' cellpadding='5' cellspacing='0'>";
    htmlTable += "<tr><th>Username</th><th>Password Hash Version</th><th>Actions</th></tr>";

    // Linhas existentes com botão de apagar
    users.forEach((u) => {
      htmlTable += `<tr>
        <td>${u.username}</td>
        <td>${u.passwordHashVersion}</td>
        <td>
          <form method="POST" action="/delete" style="display:inline">
            <input type="hidden" name="username" value="${u.username}" />
            <button type="submit">Delete</button>
          </form>
        </td>
      </tr>`;
    });

    // Linha vazia para adicionar novo usuário
    htmlTable += `<tr>
      <form method="POST" action="/add">
        <td><input type="text" name="username" placeholder="Username" required/></td>
        <td><input type="text" name="passwd" placeholder="Password"/></td>
        <td><button type="submit">Add</button></td>
      </form>
    </tr>`;

    htmlTable += "</table>";

    res.send(`
      <html>
        <head>
          <title>Kopia Server Users</title>
          <style>
            body { font-family: monospace; background: #111; color: #0f0; padding: 20px; }
            table { border-collapse: collapse; margin-top: 20px; }
            th, td { padding: 8px 12px; }
            th { background: #222; }
            td { background: #111; }
            input { background: #222; color: #0f0; border: 1px solid #0f0; padding: 2px 4px; }
            button { cursor: pointer; padding: 2px 6px; }
          </style>
        </head>
        <body>
          <h1>Kopia Users</h1>
          ${htmlTable}
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send(`Erro: ${err.message}`);
  }
});

// POST para adicionar novo usuário
app.post("/add", async (req, res) => {
  try {
    const { username, passwd } = req.body;
    console.log(`Adicionar usuário: ${username}, password: ${passwd}`);

    createUser(username, passwd);
    await sleep(15000); // espera 15 segundos para o comando ser executado

    res.redirect("/");
  } catch (err) {
    res.status(500).send(`Erro ao executar comando: ${err.message}`);
  }
});

// POST para apagar usuário
app.post("/delete", async (req, res) => {
  try {
    const { username } = req.body;
    console.log(`Apagar usuário: ${username}`);

    await deleteUser(username);
    await sleep(5000); // espera 5 segundos para aplicar a remoção
    res.redirect("/");
  } catch (err) {
    res.status(500).send(`Erro ao apagar usuário: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor HTTP rodando em http://localhost:${PORT}`);
});
