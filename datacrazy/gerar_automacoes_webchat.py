"""Gera as automações do webchat de uma faculdade para importar no DataCrazy (ADR 004).

Por que um "roteador": na Conexão Universal o DataCrazy envia só o texto das
mensagens (os botões não vão) e **não espera a resposta de um botão**. Cada
mensagem do aluno dispara de novo a automação de entrada (validado em 2026-10-10).
Então os menus do WhatsApp, que dependem de esperar o clique, não funcionam lá.

Este gerador lê o export do fluxo do WhatsApp da faculdade (boas-vindas, menus e
subfluxos, tudo no mesmo arquivo) e monta UMA automação sem estado:

    mensagem do aluno ─┬─ texto = opção de algum menu? → faz o que o botão fazia
                       ├─ primeira mensagem do atendimento? → saudação + menu de setores
                       └─ senão → nada (o aluno está escrevendo para o atendente)

- Menus e subfluxos são copiados para dentro do roteador (start-another-automation
  vira ligação direta). Os botões viram linhas "▸ Opção" no fim da mensagem: o
  widget mostra como botões e o clique manda o texto da opção.
- O backend informa `novo_atendimento: "sim"` no webhook da primeira mensagem.
- Não pede nome nem CPF e não cria lead (o backend vincula pelo CPF). Põe a tag
  Eduno, porque todo aluno do webchat vem do portal Eduno.
- Horário: os menus de setor passam por seg-qui 08-18h / sex 08-17h. Fora do
  horário, avisa e para (sem o "Manter Janela", que é coisa da janela de 24 h do
  WhatsApp). Lead com a tag de teste pula o horário.

Gera também "Webchat <faculdade>: atendimento finalizado", que avisa o backend
(POST /dc/<slug>/evento) quando o atendimento termina no DataCrazy.

Uso (a chave é o `api_key` da faculdade no backend, a mesma credencial da conexão):

    WEBCHAT_API_KEY=... python3 -I datacrazy/gerar_automacoes_webchat.py \\
        --export ~/Downloads/boas-vindas-iguaçu.json --slug iguacu \\
        --instancia 6aca6a619ab27fb81a32e33e --faculdade "Faculdade Iguaçu" \\
        --tag-teste 507ad07e-130c-4aa9-908e-64eba143a0d6

O arquivo sai em datacrazy/gerado/ (fora do git, porque leva a chave). Quando o
fluxo do WhatsApp mudar, exporte de novo e gere outra vez.
"""

import argparse
import copy
import json
import os
import re
import uuid
from collections import deque
from pathlib import Path

URL_PADRAO = "https://webchat.engrenatec.com.br"
TAG_ALUNO = "Eduno"
MARCA_OPCAO = "▸ "  # o widget transforma estas linhas em botões (public/widget.js)
MENU_INICIAL = "Menu inicial"
IGNORAR = {"Manter Janela"}  # automações que não fazem sentido fora do WhatsApp
HORARIO = [  # mesmas janelas dos menus de setor do RJ Global
    {"daysOfWeek": [1, 2, 3, 4], "startTime": "1970-01-01T11:00:00.000Z", "endTime": "1970-01-01T21:00:00.000Z"},
    {"daysOfWeek": [5], "startTime": "1970-01-01T11:00:00.000Z", "endTime": "1970-01-01T20:00:00.000Z"},
]
AVISO_HORARIO = ("Nosso atendimento administrativo funciona de *segunda a quinta-feira, das 08:00 às 18:00 "
                 "e sexta-feira das 08:00 às 17:00* 😊\n\nSua mensagem ficou registrada e a equipe responde "
                 "por aqui no próximo horário de atendimento.")


def novo_id():
    return str(uuid.uuid4())


def bloco(tipo, options):
    return {"id": novo_id(), "type": tipo, "presentation": {"x": 0, "y": 0}, "sourceBlockId": None, "options": options}


def chat(mensagens, proximo=""):
    return bloco("chat", {"messages": mensagens, "platform": "", "provider": "", "timezone": "", "contactId": "",
                          "instanceId": "", "nextBlockId": proximo, "isAnnotation": False, "scheduledDate": "",
                          "errorNextBlockId": ""})


def texto(t):
    return {"name": "send-text-message", "group": "messages", "stepId": novo_id(),
            "options": {"text": t, "buttons": [], "breakMessages": False, "breakMessagesIntervalInSeconds": 2}}


def condicao(condicoes, sim="", nao=""):
    return bloco("condition", {"conditions": condicoes, "trueNextBlockId": sim, "falseNextBlockId": nao})


def cond(nome, grupo, options, proximo=None):
    return {"id": novo_id(), "name": nome, "group": grupo, "options": options, "nextBlockId": proximo}


def so_horario(b):
    return b["type"] == "condition" and b["options"]["conditions"] and all(
        c["name"] == "current-time-interval-condition" for c in b["options"]["conditions"])


class Roteador:
    def __init__(self, dados, faculdade, tag_teste):
        self.dados = dados
        self.faculdade = faculdade
        self.tag_teste = tag_teste
        self.automacoes = {a["id"]: a for a in dados["automations"]}
        self.origem = {b["id"]: b for a in dados["automations"] for b in a["blocks"]}
        self.memo = {}         # id do bloco original -> id do bloco novo ("" = fim)
        self.portas = {}       # id da automação -> id da entrada copiada (com horário)
        self.blocos = []
        self.opcoes = {}       # texto do botão -> id original do alvo
        self.fila = deque()
        self.fora = None
        self.menu_principal = None

    # ------------------------------------------------------------- cópia ---
    def copiar(self, bid):
        if not bid:
            return ""
        if bid in self.memo:
            return self.memo[bid]
        b = self.origem[bid]
        if so_horario(b):  # o horário é tratado na porta da automação
            self.memo[bid] = self.copiar(b["options"]["trueNextBlockId"])
            return self.memo[bid]
        if b["type"] == "action":
            return self._acao(b)
        novo = copy.deepcopy(b)
        novo["id"] = self.memo[bid] = novo_id()
        novo["sourceBlockId"] = None
        o = novo["options"]
        if b["type"] == "chat":
            o.update(platform="", provider="", instanceId="")
            for m in o["messages"]:
                m["stepId"] = novo_id()
                mo = m["options"]
                if mo.get("buttons"):
                    for bt in mo["buttons"]:
                        if bt["text"] not in self.opcoes and bt.get("nextBlockId"):
                            self.opcoes[bt["text"]] = bt["nextBlockId"]
                            self.fila.append(bt["nextBlockId"])
                    linhas = [MARCA_OPCAO + bt["text"] for bt in mo["buttons"]]
                    if bid != self.menu_principal:
                        linhas.append(MARCA_OPCAO + MENU_INICIAL)
                    mo["text"] = mo["text"].rstrip() + "\n\n" + "\n".join(linhas)
                    mo["buttons"] = []
                if "timeoutNextBlockId" in mo:
                    mo["timeoutNextBlockId"] = self.copiar(mo["timeoutNextBlockId"])
        elif b["type"] == "condition":
            for c in o["conditions"]:
                c["id"] = novo_id()
                if c.get("nextBlockId"):
                    c["nextBlockId"] = self.copiar(c["nextBlockId"])
            o["trueNextBlockId"] = self.copiar(o.get("trueNextBlockId"))
            o["falseNextBlockId"] = self.copiar(o.get("falseNextBlockId"))
        elif b["type"] == "field-operation":
            for f in o.get("fieldOperations", []):
                f["stepId"] = novo_id()
        elif b["type"] not in ("delay", "api", "javascript", "randomizer", "ai"):
            raise SystemExit(f"tipo de bloco não previsto: {b['type']} ({bid})")
        if "nextBlockId" in o:
            o["nextBlockId"] = self.copiar(o["nextBlockId"])
        if o.get("errorNextBlockId"):
            o["errorNextBlockId"] = self.copiar(o["errorNextBlockId"])
        self.blocos.append(novo)
        return novo["id"]

    # Ação: "iniciar outra automação" vira ligação direta para a cópia dela.
    def _acao(self, b):
        acoes = [a for a in b["options"]["actions"] if a["name"] != "start-another-automation-action"]
        inicios = [a["options"]["automationId"] for a in b["options"]["actions"]
                   if a["name"] == "start-another-automation-action"]
        if len(inicios) > 1 or (inicios and b["options"].get("nextBlockId")):
            raise SystemExit(f"ação {b['id']}: combinação de 'iniciar automação' não prevista")
        if not acoes:  # só iniciava outra automação: o bloco some
            self.memo[b["id"]] = self.porta(inicios[0]) if inicios else self.copiar(b["options"].get("nextBlockId"))
            return self.memo[b["id"]]
        novo = copy.deepcopy(b)
        novo["id"] = self.memo[b["id"]] = novo_id()
        novo["sourceBlockId"] = None
        novo["options"]["actions"] = acoes
        novo["options"]["nextBlockId"] = self.porta(inicios[0]) if inicios else self.copiar(b["options"].get("nextBlockId"))
        if novo["options"].get("errorNextBlockId"):
            novo["options"]["errorNextBlockId"] = self.copiar(novo["options"]["errorNextBlockId"])
        self.blocos.append(novo)
        return novo["id"]

    # Entrada de uma automação copiada. Se ela começava checando horário (menus
    # de setor), a porta faz a checagem padrão, com escape para o lead de teste.
    def porta(self, automacao_id):
        if automacao_id in self.portas:
            return self.portas[automacao_id]
        a = self.automacoes.get(automacao_id)
        if not a or a["name"] in IGNORAR:
            return ""
        gatilho = next(b for b in a["blocks"] if b["type"] == "trigger")
        entrada = gatilho["options"]["nextBlockId"]
        if not so_horario(self.origem[entrada]):
            self.portas[automacao_id] = self.copiar(entrada)
            return self.portas[automacao_id]
        sexta = condicao([cond("current-time-interval-condition", "time", {**HORARIO[1], "timezone": "America/Sao_Paulo"})])
        semana = condicao([cond("current-time-interval-condition", "time", {**HORARIO[0], "timezone": "America/Sao_Paulo"})],
                          nao=sexta["id"])
        primeira = semana
        if self.tag_teste:
            primeira = condicao([cond("lead-has-tag-condition", "lead", {"tagIds": [self.tag_teste]})], nao=semana["id"])
            self.blocos.append(primeira)
        self.portas[automacao_id] = primeira["id"]
        destino = self.copiar(entrada)
        if self.tag_teste:
            primeira["options"]["trueNextBlockId"] = destino
        semana["options"]["trueNextBlockId"] = sexta["options"]["trueNextBlockId"] = destino
        sexta["options"]["falseNextBlockId"] = self.aviso_fora()
        self.blocos += [semana, sexta]
        return primeira["id"]

    def aviso_fora(self):
        if not self.fora:
            self.fora = chat([texto(AVISO_HORARIO)])
            self.blocos.append(self.fora)
        return self.fora["id"]

    # ------------------------------------------------------------ montagem ---
    def montar(self, instancia):
        entrada = next(a for a in self.dados["automations"] if any(
            t["name"] == "message-received-trigger"
            for b in a["blocks"] if b["type"] == "trigger" for t in b["options"]["triggers"]))
        self.menu_principal = next(b["id"] for b in entrada["blocks"] if b["type"] == "chat" and any(
            m["options"].get("buttons") and "setor" in m["options"].get("text", "").lower()
            for m in b["options"]["messages"]))
        menu = self.copiar(self.menu_principal)
        while self.fila:
            self.copiar(self.fila.popleft())

        tag = next((t for t in self.dados["tags"] if t["name"] == TAG_ALUNO), None)
        ola_nome = chat([texto(f"Olá, {{Primeiro nome do lead|leadFirstName}}! Bem-vindo(a) ao atendimento da {self.faculdade}.")], menu)
        if tag:
            marcar = bloco("action", {"actions": [{"name": "add-tag-action", "group": "lead", "options": {
                "tagIds": [tag["id"]], "tagName": "", "resolvedReferences": {"tags": [tag]}}}],
                "nextBlockId": menu, "errorNextBlockId": menu})
            ola_nome["options"]["nextBlockId"] = marcar["id"]
            self.blocos.append(marcar)
        ola = chat([texto(f"Olá! Bem-vindo(a) ao atendimento da {self.faculdade}.")], menu)
        # O lead normalmente já está vinculado: o backend vincula quando o aluno abre o chat.
        lead = condicao([cond("lead-exists-condition", "lead", {})], ola_nome["id"], ola["id"])
        inicio = condicao([cond("field-is-equal-condition", "field",
                                {"equalsTo": "sim", "parameter": "[Message-1]novo_atendimento"})], lead["id"], "")
        opcoes = [cond("field-is-equal-condition", "field", {"equalsTo": txt, "parameter": "[Message-1]text"},
                       self.memo[alvo] or None) for txt, alvo in self.opcoes.items() if self.memo.get(alvo)]
        opcoes.append(cond("field-is-equal-condition", "field", {"equalsTo": MENU_INICIAL, "parameter": "[Message-1]text"}, menu))
        roteador = condicao(opcoes, "", inicio["id"])
        # Com atendente humano na conversa, o robô não fala (o gatilho continua
        # disparando mesmo depois que o atendente assume).
        humano = condicao([cond("field-is-equal-condition", "field",
                                {"equalsTo": "sim", "parameter": "[Message-1]com_atendente"})], "", roteador["id"])
        gatilho = bloco("trigger", {"triggers": [{"name": "message-received-trigger", "group": "messages", "options": {
            "type": "contains", "keywords": [], "instanceId": instancia, "listenGroup": False, "receiveJson": True,
            "datasourceName": "Message-1", "datasourceColor": "#3b82f6",
            "initializeSession": "only-if-finished-service"}}], "nextBlockId": humano["id"]})
        self.blocos = [gatilho, humano, roteador, inicio, lead, ola_nome, ola] + self.blocos
        organizar(self.blocos)
        return [o["options"]["equalsTo"] for o in opcoes]


def proximos(b):
    achados = []

    def varrer(x):
        if isinstance(x, dict):
            for k, v in x.items():
                if isinstance(v, str) and k.lower().endswith("nextblockid") and v:
                    achados.append(v)
                else:
                    varrer(v)
        elif isinstance(x, list):
            for v in x:
                varrer(v)
    varrer(b["options"])
    return achados


# Layout em camadas a partir do gatilho: uma coluna por profundidade.
def organizar(blocos):
    por_id = {b["id"]: b for b in blocos}
    nivel = {blocos[0]["id"]: 0}
    fila = deque([blocos[0]["id"]])
    while fila:
        atual = fila.popleft()
        for p in proximos(por_id[atual]):
            if p in por_id and p not in nivel:
                nivel[p] = nivel[atual] + 1
                fila.append(p)
    linhas = {}
    for b in blocos:
        n = nivel.get(b["id"], max(nivel.values()) + 1)
        b["presentation"] = {"x": n * 520, "y": linhas.get(n, 0)}
        linhas[n] = linhas.get(n, 0) + 420


def automacao(nome, tenant, blocos, nota):
    return {
        "id": novo_id(), "name": nome, "description": "Webchat do portal Eduno (ADR 004)", "group": "Webchat",
        "active": False, "imageUrl": "", "loopLevel": 1, "versionId": novo_id(), "versionName": nome, "version": 1,
        "tenantId": tenant, "blocks": blocos,
        "notes": [{"id": novo_id(), "options": {"text": nota, "color": "#bae6fd", "width": 520, "height": 520},
                   "presentation": {"x": -700, "y": -250}}],
    }


def finalizado(tenant, instancia, faculdade, slug, url, chave):
    api = bloco("api", {"apis": [{"name": "json-http-request-api", "group": "http", "options": {
        "url": f"{url}/dc/{slug}/evento", "method": "POST", "query": [],
        "body": json.dumps({"evento": "atendimento_finalizado", "conversationId": "${conversationId}", "leadId": "${leadId}"}),
        "headers": [{"key": "Content-Type", "value": "application/json"}, {"key": "X-Api-Key", "value": chave}],
        "datasourceName": "Api-request-1", "datasourceColor": "#3b82f6"}}], "nextBlockId": "", "errorNextBlockId": ""})
    gatilho = bloco("trigger", {"triggers": [{"name": "thread-finished-trigger", "group": "messages",
                                              "options": {"instanceId": instancia}}], "nextBlockId": api["id"]})
    blocos = [gatilho, api]
    organizar(blocos)
    nota = (f"🔚 WEBCHAT {faculdade}: ATENDIMENTO FINALIZADO\n\n"
            "Quando o atendimento termina aqui (atendente finalizou, robô encerrou por inatividade...), "
            "avisa o backend do webchat, que encerra o atendimento no widget do aluno.\n\n"
            "⚠️ O header X-Api-Key leva a mesma chave da credencial da conexão.")
    return automacao(f"Webchat {faculdade}: atendimento finalizado", tenant, blocos, nota)


def validar(automacoes):
    for a in automacoes:
        ids = {b["id"] for b in a["blocks"]}
        refs = set(re.findall(r'[Nn]extBlockId": "([0-9a-f-]{36})"', json.dumps(a["blocks"])))
        assert refs <= ids, f"{a['name']}: referências quebradas {refs - ids}"


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--export", required=True, help="export do fluxo do WhatsApp (boas-vindas, menus e subfluxos)")
    p.add_argument("--slug", required=True)
    p.add_argument("--instancia", required=True, help="id da Conexão Universal do webchat")
    p.add_argument("--faculdade", required=True, help='nome exibido, ex.: "Faculdade Iguaçu"')
    p.add_argument("--tag-teste", default="", help="id da tag que pula a checagem de horário (lead de teste)")
    p.add_argument("--url", default=URL_PADRAO)
    a = p.parse_args()
    chave = os.environ.get("WEBCHAT_API_KEY")
    if not chave:
        raise SystemExit("defina WEBCHAT_API_KEY (api_key da faculdade no backend)")

    dados = json.load(open(a.export))["data"]
    tenant = dados["automations"][0]["tenantId"]
    r = Roteador(dados, a.faculdade, a.tag_teste)
    opcoes = r.montar(a.instancia)
    nota = (f"💬 WEBCHAT {a.faculdade}: ROTEADOR\n\n"
            "Na Conexão Universal os botões não são enviados e o DataCrazy não espera o clique: "
            "cada mensagem do aluno roda esta automação.\n\n"
            "0. Atendente humano já assumiu (com_atendente = sim) → nada\n"
            "1. Texto igual a uma opção de menu → faz o que o botão fazia no WhatsApp\n"
            "2. Primeira mensagem do atendimento (novo_atendimento = sim) → saudação, tag Eduno e menu de setores\n"
            "3. Senão → nada (o aluno está falando com o atendente)\n\n"
            "Os botões viram linhas \"▸ Opção\"; o widget mostra como botões.\n"
            "Não pede nome nem CPF e não cria lead.\n\n"
            "⚠️ Gerado por datacrazy/gerar_automacoes_webchat.py a partir do fluxo do WhatsApp. "
            "Não edite aqui: mude o fluxo do WhatsApp, exporte e gere de novo (ADR 004).")
    automacoes = [automacao(f"Webchat {a.faculdade}: roteador", tenant, r.blocos, nota),
                  finalizado(tenant, a.instancia, a.faculdade, a.slug, a.url, chave)]
    validar(automacoes)
    saida = Path(__file__).parent / "gerado" / f"webchat-{a.slug}.json"
    saida.parent.mkdir(exist_ok=True)
    tags = [t for t in dados["tags"] if t["name"] == TAG_ALUNO]
    json.dump({"hasInvalidReferences": False, "data": {
        "tags": tags, "additionalFields": [], "businessLossReasons": [], "activityTypes": [], "pipelines": [],
        "departments": dados["departments"], "workingHours": [], "automations": automacoes}},
        open(saida, "w"), ensure_ascii=False, indent=2)
    print(f"{saida}: roteador com {len(r.blocos)} blocos e {len(opcoes)} opções")
    print("opções:", opcoes)


if __name__ == "__main__":
    main()
