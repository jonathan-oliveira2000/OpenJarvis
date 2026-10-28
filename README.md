# M.E.G.A. — Máquina Extremamente Genial (Aparentemente)

**M.E.G.A.** é um assistente de IA com interface web e conversa por voz, baseado no projeto OpenJarvis. A inferência pode usar um motor local; integrações externas só são usadas quando configuradas.

[![Python: 3.10–3.13](https://img.shields.io/badge/Python-3.10%E2%80%933.13-blue)](pyproject.toml)
[![Licença Apache 2.0](https://img.shields.io/badge/licen%C3%A7a-Apache%202.0-green)](LICENSE)

<!-- TODO: captura de tela da interface do M.E.G.A. -->

## Sumário

- [Visão geral e recursos](#visao-geral-e-recursos)
- [Arquitetura](#arquitetura)
- [Requisitos](#requisitos)
- [Instalação no Windows](#instalacao-no-windows)
- [Variáveis de ambiente](#variaveis-de-ambiente)
- [Executar o projeto](#executar-o-projeto)
- [Primeiro acesso](#primeiro-acesso)
- [Usar o M.E.G.A. por voz](#usar-o-mega-por-voz)
- [Segurança e privacidade](#seguranca-e-privacidade)
- [Solução de problemas](#solucao-de-problemas)
- [Testes e desenvolvimento](#testes-e-desenvolvimento)
- [Roadmap](#roadmap)
- [Créditos e licença](#creditos-e-licenca)

<a id="visao-geral-e-recursos"></a>
## Visão geral e recursos

O M.E.G.A. combina uma interface web de chat com uma página de voz. Entre os recursos disponíveis estão:

- Conversa por voz: captura de áudio no navegador, transcrição no backend e resposta falada.
- Interrupção por voz (barge-in): falar enquanto o M.E.G.A. responde pode interromper a fala atual; a resposta pode ser retomada.
- Repetição da resposta falada por comando.
- Login obrigatório, cadastro de contas e papel de usuário/admin verificado no servidor.
- Histórico web persistido por usuário e protegido contra leitura por outra conta.
- Integração com motores de inferência locais e remotos suportados pelo projeto. Ollama é uma opção local documentada neste guia; a configuração selecionada determina o motor efetivamente usado.
- Interface web com chat, histórico e página de voz.

O M.E.G.A. não exige que o modelo de linguagem rode em um serviço externo. Se você escolher um provedor de nuvem, configurar pesquisa externa ou habilitar outra integração que use a rede, os dados necessários a esse serviço sairão da máquina.

<a id="arquitetura"></a>
## Arquitetura

```text
Navegador
  ├─ Chat web ───────────────────────┐
  ├─ Microfone → áudio WAV 16 kHz ───┤
  └─ Voz falada pelo navegador ──────┤
                                     ▼
                              API FastAPI
                    ┌───────────┼─────────────┐
                    ▼           ▼             ▼
              Motor/modelo   faster-whisper  SQLite
              configurado       (STT)       auth + histórico
                    │
                    └── TTS do servidor opcional (por configuração)
```

No desenvolvimento, o Vite serve a interface e encaminha `/auth`, `/v1`, `/api` e `/health` para o backend. Em uma compilação de produção, o build do frontend é escrito em `src/openjarvis/server/static` e o backend serve os arquivos e as rotas da aplicação.

O fluxo de voz é: o usuário inicia a escuta e concede acesso ao microfone; o navegador identifica trechos de fala e os envia para transcrição; o texto segue para o motor de conversa selecionado; a resposta é apresentada no histórico e falada frase a frase. O adapter de voz padrão usa a síntese de fala do próprio navegador. O adapter de servidor é opcional e depende de um backend TTS configurado.

<a id="requisitos"></a>
## Requisitos

### Software

| Componente | Requisito confirmado |
|---|---|
| Windows | O projeto contém frontend e backend compatíveis com o fluxo de instalação abaixo. |
| Python | `>=3.10,<3.14`, conforme `pyproject.toml` e `uv.lock`. Python 3.13 está dentro do intervalo. |
| uv | Necessário para sincronizar o ambiente e executar `jarvis`. O repositório não fixa uma versão mínima de uv. |
| Node.js | `>=22.22`, conforme `frontend/package.json`. |
| npm | `>=11.19.0,<12`, conforme `frontend/package.json`. |
| Git | Necessário para clonar o repositório. O projeto não fixa uma versão mínima. |
| Motor de inferência | Necessário para conversar com um modelo. Ollama é usado pelo exemplo `chat-simple`; não há uma versão mínima local fixada no código. |
| Navegador | Use um navegador desktop atualizado com suporte a microfone (`getUserMedia`), AudioWorklet e síntese de fala. Chrome ou Edge são uma recomendação prática, não uma certificação de compatibilidade de microfone. |

O projeto não declara um requisito mínimo universal de RAM ou GPU: o uso depende do modelo e do motor escolhidos. A configuração inicial detecta hardware e recomenda um modelo; não é uma garantia de que qualquer modelo caberá na memória. GPU NVIDIA é opcional: há detecção e suporte a métricas NVIDIA, mas não é requisito para o fluxo. Não há exigência de FFmpeg identificada para a captura WAV do navegador com faster-whisper.

### Links oficiais de instalação

- [Git para Windows](https://git-scm.com/download/win)
- [Python para Windows](https://www.python.org/downloads/windows/)
- [Instalação do uv](https://docs.astral.sh/uv/getting-started/installation/)
- [Node.js](https://nodejs.org/en/download)
- [Ollama para Windows](https://ollama.com/download/windows)

<a id="instalacao-no-windows"></a>
## Instalação no Windows

Execute os comandos em PowerShell. A instalação e os downloads dependem da conexão com a internet. Este guia usa Ollama e o preset `chat-simple` como um caminho de exemplo; o projeto também aceita outros motores.

### 1. Instale e confira os pré-requisitos

Instale Git, Python 3.10 a 3.13, uv, Node.js compatível com `package.json` e Ollama pelos links acima. Depois feche e reabra o PowerShell para atualizar o `PATH`.

Instale o uv pelo instalador oficial para PowerShell:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

**O que esperar:** o instalador configura o comando `uv`; reabra o terminal se ele ainda não estiver no `PATH`. Git, Python, Node.js e Ollama são instalados pelos instaladores oficiais vinculados acima; o repositório não determina seus comandos de instalação para Windows.

```powershell
git --version
python --version
uv --version
node --version
npm --version
ollama --version
```

**O que esperar:** os comandos imprimem as versões instaladas. Para Node.js e npm, confirme os limites da tabela de requisitos. O repositório não fixa uma versão do Ollama para instalação local; `ollama --version` apenas confirma que o executável está disponível.

### 2. Clone o repositório

```powershell
git clone https://github.com/jonathan-oliveira2000/OpenJarvis.git
```

```powershell
Set-Location OpenJarvis
```

**O que esperar:** a pasta `OpenJarvis` é criada e o segundo comando entra nela. Confirme com `Get-Location`.

### 3. Instale as dependências do backend

```powershell
uv sync --extra desktop
```

**O que esperar:** uv cria ou atualiza o ambiente do projeto usando o lockfile. O extra `desktop` inclui as dependências do servidor web e o backend faster-whisper, necessário à transcrição local da voz web.

Extras opcionais confirmados em `pyproject.toml`:

| Extra | Quando usar |
|---|---|
| `voice` | Para os backends locais de voz e áudio usados nos fluxos de fala do backend/CLI. |
| `inference-cloud` | Para backends de inferência OpenAI ou Anthropic. |
| `inference-google` | Para o backend Google GenAI. |
| `inference-vllm` | Para usar o backend vLLM. A instalação e configuração do próprio motor são separadas. |
| `dev` | Para testes, lint e ferramentas de desenvolvimento. |

Por exemplo, para incluir o TTS local do extra `voice`:

```powershell
uv sync --extra desktop --extra voice
```

Não instale todos os extras indiscriminadamente: alguns trazem dependências pesadas ou serviços externos. Para outras integrações, consulte os extras listados em `pyproject.toml`.

### 4. Instale e baixe um modelo

O exemplo `configs/openjarvis/examples/chat-simple.toml` usa Ollama e `qwen3.5:4b`. Baixe esse modelo:

```powershell
ollama pull qwen3.5:4b
```

**O que esperar:** Ollama baixa o modelo. O repositório não fornece um tamanho de download verificado para este modelo, então não há estimativa de espaço indicada aqui.

Confira a lista local:

```powershell
ollama list
```

**Observação:** `jarvis init` sem preset escolhe uma configuração de acordo com o hardware detectado; não existe um único modelo padrão para todas as máquinas. O comando de pull acima corresponde ao preset `chat-simple` usado no próximo passo.

O backend STT usa faster-whisper com modelo `base` por padrão e carrega o modelo sob demanda. O tamanho do download depende do modelo e da implementação; o repositório não publica um tamanho fixo confirmado.

### 5. Crie a configuração inicial

Se ainda não existe uma configuração que queira preservar, gere o preset de chat simples:

```powershell
uv run jarvis init --preset chat-simple --no-download
```

**O que esperar:** `jarvis init` cria a configuração do usuário e não inicia o download interativo de modelo. O preset usa Ollama e `qwen3.5:4b`. Confira os valores gerados em `%USERPROFILE%\.openjarvis\config.toml`.

> **Atenção:** se já houver configuração, não use `--force` sem revisar o arquivo: essa opção permite sobrescrevê-lo. Para conhecer outras opções confirmadas, rode `uv run jarvis init --help`.

Por padrão, a configuração fica em `%USERPROFILE%\.openjarvis\config.toml`. `OPENJARVIS_HOME` pode mudar a pasta de estado; `OPENJARVIS_CONFIG` pode apontar para um arquivo TOML específico. Veja [Variáveis de ambiente](#variaveis-de-ambiente).

### 6. Instale e compile o frontend

```powershell
Set-Location frontend
```

```powershell
npm ci
```

**O que esperar:** npm instala as dependências exatamente conforme `frontend/package-lock.json`. `npm ci` requer um lockfile presente, que existe neste repositório.

Para compilar:

```powershell
npm run build
```

**O que esperar:** TypeScript é verificado e Vite gera os arquivos estáticos em `src/openjarvis/server/static`. Para retornar à raiz:

```powershell
Set-Location ..
```

<a id="variaveis-de-ambiente"></a>
## Variáveis de ambiente

| Variável | Função | Padrão / exemplo |
|---|---|---|
| `MEGA_ADMIN_NAME` | Nome da conta admin criada/atualizada no startup quando fornecida junto com a senha. | Sem padrão; por exemplo, `admin`. |
| `MEGA_ADMIN_PASSWORD` | Senha de seed do admin. Deve ter pelo menos 8 caracteres. | Sem padrão; defina uma senha forte e não a versione. |
| `MEGA_SESSION_TTL_SECONDS` | Duração máxima da sessão. | `604800` segundos (7 dias). |
| `MEGA_AUTH_MAX_FAILURES` | Tentativas de login falhas antes do bloqueio temporário. | `5`. |
| `MEGA_AUTH_RATE_WINDOW_SECONDS` | Janela e período do bloqueio de tentativas. | `900` segundos. |
| `OPENJARVIS_HOME` | Muda a pasta de configuração, banco e outros dados locais. | `%USERPROFILE%\.openjarvis` por padrão no Windows; exemplo: `D:\MegaData`. |
| `OPENJARVIS_CONFIG` | Usa um arquivo TOML de configuração específico. | Não definido; por padrão usa `config.toml` sob a pasta de configuração. |
| `OPENJARVIS_CORS_ORIGINS` | Lista separada por vírgulas das origens exatas permitidas para acesso web. | Por padrão, origens locais `localhost`/`127.0.0.1` nas portas 5173/5174 e origens Tauri. Exemplo: `https://mega.exemplo.com`. |
| `OPENJARVIS_API_KEY` | Chave adicional da API; necessária quando o servidor é configurado para escutar em interface de rede não local. | Não definida por padrão. Não exponha a chave no frontend. |
| `OPENJARVIS_VITE_PROXY_TARGET` | Destino do proxy do Vite em desenvolvimento, usado pelo comando `jarvis gui`. | `http://localhost:8000`, se `VITE_API_URL` não estiver definido. |
| `VITE_API_URL` | URL base da API usada pelo frontend/Vite quando configurada. | Não definida; em desenvolvimento, o proxy usa o backend local. |

As variáveis legadas `JARVIS_ADMIN_NAME`, `JARVIS_ADMIN_PASSWORD`, `JARVIS_SESSION_TTL_SECONDS`, `JARVIS_AUTH_MAX_FAILURES` e `JARVIS_AUTH_RATE_WINDOW_SECONDS` continuam aceitas. Quando a versão `MEGA_*` e a legada correspondente estiverem definidas, `MEGA_*` vence.

Para configurar um admin por seed em PowerShell, defina as duas variáveis antes de iniciar o servidor:

```powershell
$env:MEGA_ADMIN_NAME = "admin"
$env:MEGA_ADMIN_PASSWORD = "<substitua-por-uma-senha-forte>"
```

Não coloque segredos em arquivos versionados, comandos compartilhados ou capturas de tela.

<a id="executar-o-projeto"></a>
## Executar o projeto

### Desenvolvimento com dois terminais

Antes, conclua a configuração e confira que Ollama está em execução e que o modelo escolhido aparece em `ollama list`.

No **Terminal 1**, na raiz do repositório:

```powershell
uv run jarvis serve --host 127.0.0.1 --port 8000
```

O comando `serve` inicia a API. Os argumentos `--host` e `--port` foram confirmados com `uv run jarvis serve --help`. Deixe o terminal aberto.

No **Terminal 2**, entre na pasta do frontend e inicie Vite:

```powershell
Set-Location frontend
npm run dev -- --host 127.0.0.1 --port 5173
```

Abra `http://127.0.0.1:5173`. O proxy configurado em `vite.config.ts` encaminha as rotas da API para `http://localhost:8000` por padrão.

### Build estático servido pelo backend

Depois de executar `npm run build` na pasta `frontend`, os arquivos ficam em `src/openjarvis/server/static`. Inicie o backend na raiz:

```powershell
uv run jarvis serve --host 127.0.0.1 --port 8000
```

Abra `http://127.0.0.1:8000`. Esse caminho depende de os arquivos do build estarem presentes; o servidor também tem um fallback de rotas para a aplicação web.

### Inicialização integrada e desktop

`uv run jarvis gui` é um comando existente para iniciar o backend e a interface de desenvolvimento a partir de um checkout, e abrir a interface no navegador. Ele requer Node.js/npm disponíveis no `PATH`. Suas opções confirmadas estão em `uv run jarvis gui --help`.

O empacotamento nativo Tauri existe no repositório, mas seus pré-requisitos de build e a instalação de um pacote desktop não foram verificados neste guia. Trate-o como opcional.

<a id="primeiro-acesso"></a>
## Primeiro acesso

Abra a interface e escolha **Cadastre-se**. O nome precisa ter pelo menos 3 caracteres e a senha pelo menos 8. Após criar a conta, o sistema mostra uma confirmação e retorna ao login; o cadastro não autentica automaticamente.

> **Importante:** sem seed, o primeiro usuário cadastrado em uma base sem usuários recebe o papel `admin`; os seguintes recebem `user`. Cadastre o administrador pretendido antes de expor o servidor à rede. Alternativamente, defina `MEGA_ADMIN_NAME` e `MEGA_ADMIN_PASSWORD` antes do startup.

O login cria a sessão em cookie HttpOnly. As páginas do chat, histórico e voz não ficam disponíveis sem uma sessão válida. Para detalhes sobre rotas, cookies, rate limit e armazenamento, consulte o [guia de autenticação web](docs/user-guide/web-authentication.md).

<a id="usar-o-mega-por-voz"></a>
## Usar o M.E.G.A. por voz

1. Abra a página do M.E.G.A. e selecione um modelo na tela de chat, se ainda não houver um selecionado.
2. Inicie a escuta e permita o acesso ao microfone quando o navegador pedir.
3. Fale normalmente. A transcrição usa o backend; a voz padrão de resposta é a síntese do navegador em português do Brasil, quando uma voz compatível estiver disponível.
4. Enquanto o M.E.G.A. fala, você pode falar por cima para interromper e fazer uma nova pergunta. A resposta interrompida pode ser retomada.
5. Diga “repita” para ouvir novamente a fala da resposta anterior.

Fones de ouvido são recomendados para reduzir eco e evitar que a fala reproduzida seja capturada pelo microfone. Nas configurações, é possível escolher adapter, voz e velocidade, além de ajustar sensibilidade e comportamento da escuta.

A palavra de ativação “Mega” é uma opção da sessão de voz, desativada por padrão; o alias legado “Jarvis” também fica desativado por padrão. Isso não é um modo standby 24/7: a escuta precisa ser iniciada pelo usuário. O modo standby contínuo consta no [Roadmap](#roadmap).

<a id="seguranca-e-privacidade"></a>
## Segurança e privacidade

- Senhas são armazenadas com hash `scrypt` e salt. Sessões usam tokens opacos aleatórios em cookies HttpOnly; o banco guarda o hash do token.
- A autenticação segue uma política default-deny: APIs, chat em streaming, STT, TTS, histórico e WebSockets exigem sessão. As exceções de sessão são `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` e `GET /health`; os assets estáticos também podem ser carregados sem sessão para permitir a tela de login.
- O banco `web-auth.db`, usuários, sessões e histórico web ficam sob `OPENJARVIS_HOME` (padrão `%USERPROFILE%\.openjarvis`). As conversas armazenadas no servidor são associadas ao usuário autenticado. O frontend também mantém cache local separado por usuário.
- O áudio da fala é enviado ao backend configurado para STT. A pergunta e o contexto de conversa seguem ao motor/modelo selecionado. Com Ollama local, o modelo é executado no serviço local; um motor ou TTS de nuvem pode receber os dados necessários quando for selecionado/configurado.
- O TTS padrão do navegador não requer o envio do texto ao endpoint TTS do servidor. O adapter de servidor depende do backend TTS configurado, que pode ser local ou externo.
- Analytics anônimo de uso é desativado por padrão; quando ativado na configuração, eventos são enviados ao serviço PostHog configurado. Downloads iniciais de pacotes e modelos também precisam acessar seus respectivos serviços. Não é correto assumir que todos os recursos, em qualquer configuração, permanecem offline.
- Para um servidor acessível pela rede, restrinja `OPENJARVIS_CORS_ORIGINS` às origens exatas e configure `OPENJARVIS_API_KEY` quando exigido pelo bind. Não use CORS `*`.
- Webhooks e callbacks OAuth também exigem sessão atualmente. Recuperação de senha e exclusão de conta não estão implementadas.

<a id="solucao-de-problemas"></a>
## Solução de problemas

| Sintoma | Causa provável | Como verificar / resolver |
|---|---|---|
| `program not found` ao executar `uv run jarvis` | O comando está sendo executado fora do projeto ou as dependências/entry point não foram sincronizados. | Entre na raiz que contém `pyproject.toml` e execute `uv sync --extra desktop`; depois confira `uv run jarvis --help`. |
| Erro 10048 ou porta 8000 ocupada | Outro processo está ouvindo na porta da API. | Veja o PID com `Get-NetTCPConnection -LocalPort 8000 -State Listen \| Select-Object LocalAddress,LocalPort,OwningProcess`. Confira-o com `Get-Process -Id <PID>`. Só então, se tiver certeza de que é o processo que deseja encerrar, use `Stop-Process -Id <PID>`. Ou escolha outra porta e ajuste o alvo do proxy. |
| “Não foi possível conectar” ou `Unexpected token '<' ... is not valid JSON` | A URL está devolvendo HTML (por exemplo, o `index.html`) em vez da resposta JSON da API; pode ser backend antigo, frontend sem proxy correto ou URL base errada. | Abra `http://127.0.0.1:8000/auth/me` diretamente. Sem login, a resposta esperada é JSON com status 401, não HTML. Reinicie o backend desta checkout e, em desenvolvimento, confira se Vite encaminha `/auth` para a porta 8000. |
| A interface antiga continua aparecendo depois de atualizar | Cache do navegador ou service worker/PWA servindo assets anteriores. | Faça refresh forçado (`Ctrl+F5`). Se necessário, remova os dados do site/service worker nas ferramentas do navegador e reabra a página. |
| `npm` não encontrado ou `WinError 2` ao iniciar a interface | Node.js/npm não estão instalados, não estão no `PATH` ou o terminal ainda não foi reaberto após a instalação. | Rode `node --version` e `npm --version`; reinstale/ajuste Node.js e abra um PowerShell novo. `jarvis gui` depende de npm no `PATH`. |
| Microfone bloqueado ou sem áudio | Permissão negada, microfone errado selecionado ou aba sem acesso ao dispositivo. | Permita microfone nas permissões do site e no Windows, confira o dispositivo de entrada e recarregue. Use `127.0.0.1` ou HTTPS; microfone depende de contexto seguro. |
| A voz soletra o nome ou não fala | Voz do navegador incompatível/indisponível, volume do sistema ou adapter inadequado. | Selecione uma voz `pt-BR` nas configurações do M.E.G.A., confira o volume e mantenha o adapter navegador como padrão. A normalização de `M.E.G.A.` para “Mega” é coberta por testes; a voz física do seu navegador/dispositivo não foi validada aqui. |
| Ollama não encontrado ou modelo indisponível | Ollama não está instalado/em execução, ou o modelo não foi baixado. | Confira `ollama --version` e `ollama list`. Para o preset `chat-simple`, rode `ollama pull qwen3.5:4b` e confirme a configuração em `config.toml`. |
| Modelo lento ou erro de memória | O modelo pode ser grande para a RAM/VRAM disponível ou o motor está executando sem aceleração adequada. | Use um modelo menor suportado pelo motor, feche aplicações que consumam memória e verifique a recomendação gerada por `jarvis init`. Os requisitos dependem do modelo; não há mínimo universal publicado pelo projeto. |
| Transcrição falha ou demora | Dependência STT ausente, primeiro carregamento do modelo ou serviço backend indisponível. | Confirme que usou `uv sync --extra desktop`, que `jarvis serve` está ativo e que o endpoint `/health` responde. A primeira transcrição pode precisar carregar o modelo faster-whisper. |

<a id="testes-e-desenvolvimento"></a>
## Testes e desenvolvimento

Na raiz do repositório, instale as dependências de desenvolvimento se necessário:

```powershell
uv sync --extra dev --extra desktop
```

Execute os testes do frontend:

```powershell
Set-Location frontend
npm test
```

Compile e verifique tipos do frontend:

```powershell
npm run build
```

Volte à raiz para executar a suíte Python:

```powershell
Set-Location ..
uv run pytest
```

A suíte backend completa pode ter falhas relacionadas ao ambiente Windows, incluindo testes de canais que precisam iniciar processos externos (por exemplo, WinError 2 quando o executável/ambiente Baileys não está disponível) e testes de WebSocket. Não presuma que uma suíte completa está verde; examine cada resultado e diferencie dependências de ambiente de regressões.

Estrutura principal:

| Caminho | Conteúdo |
|---|---|
| `src/openjarvis/` | Backend Python, CLI, servidor e motores. |
| `frontend/src/` | Aplicação React/TypeScript, chat e voz. |
| `configs/openjarvis/` | Configurações e presets de exemplo. |
| `docs/` | Documentação de recursos e do projeto original. |
| `tests/` | Testes Python e frontend. |

Para contribuir, mantenha mudanças focadas, atualize testes e documentação relacionados e rode as verificações pertinentes antes de abrir uma contribuição. O [guia upstream de contribuição](docs/README.openjarvis-upstream.md#contributing) descreve o processo original.

<a id="roadmap"></a>
## Roadmap

Itens planejados para etapas futuras, não apresentados como recursos prontos:

- modo standby contínuo, ativado pela palavra “Mega”;
- painel e preferências de voz restritos a administradores;
- remoção do campo de texto da página de voz;
- credenciais e fluxos OAuth por usuário, incluindo callbacks externos compatíveis com autenticação.

<a id="creditos-e-licenca"></a>
## Créditos e licença

O M.E.G.A. é baseado no projeto [OpenJarvis](https://github.com/open-jarvis/OpenJarvis). O [README original em inglês](docs/README.openjarvis-upstream.md) foi preservado para referência; o logo com a marca upstream aparece apenas nesse documento.

O repositório declara a licença **Apache License 2.0** em `pyproject.toml`; consulte o arquivo [LICENSE](LICENSE) para o texto e os avisos aplicáveis.
