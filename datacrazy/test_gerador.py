"""Validação sem CRM: python3 -I datacrazy/test_gerador.py <export original.json>."""
import copy
import importlib.util
import json
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("gerador", Path(__file__).with_name("gerar_automacoes_webchat.py"))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
dados = json.load(open(sys.argv[1]))["data"]
antes = copy.deepcopy(dados)
r = g.Roteador(dados, "Faculdade Iguaçu", "teste", nativo=True,
              callback_url="https://teste.invalid/dc/teste/evento", api_key="chave-ficticia")
r.montar("universal-teste")
g.validar([{"name": "teste", "blocks": r.blocos}])
assert dados == antes, "não pode alterar o export original em memória"
original = [m for a in dados["automations"] for b in a["blocks"] for m in b["options"].get("messages", [])]
adaptado = [m for b in r.blocos for m in b["options"].get("messages", [])]
arquivos = lambda ms: sorted(json.dumps(m["options"], sort_keys=True) for m in ms if m["name"] == "send-file-message")
assert arquivos(original) == arquivos(adaptado), "preservar todos os anexos e seus parâmetros"
assert len(arquivos(adaptado)) == 14
assert all(b["options"].get("platform", "") == "" and b["options"].get("instanceId", "") == ""
           for b in r.blocos if b["type"] == "chat")
assert not any(m["options"].get("parameter") in ("leadName", "leadTaxId") for m in adaptado)
assert not any(a["name"] in ("create-lead-action", "start-another-automation-action")
               for b in r.blocos for a in b["options"].get("actions", []))
assert all(a["options"]["type"] == "current-conversation"
           for b in r.blocos for a in b["options"].get("actions", [])
           if a["name"] == "change-conversation-department-action")
# Mesmos rótulos em diferentes menus precisam conservar ramos diferentes.
encerramentos = [bt["nextBlockId"] for m in adaptado for bt in m["options"].get("buttons", [])
                 if bt["text"] == "Encerrar atendimento"]
assert len(encerramentos) == 2 and len(set(encerramentos)) == 2
assert len([bt for m in adaptado for bt in m["options"].get("buttons", []) if bt["text"] != "Atendimento encerrado"]) == 30
assert all(any(bt["text"] == "Atendimento encerrado" for bt in m["options"]["buttons"]) for m in adaptado if m["options"].get("buttons"))
assert all(bt["nextBlockId"] == r.ack_encerramento["id"] for m in adaptado
           for bt in m["options"].get("buttons", []) if bt["text"] == "Atendimento encerrado")
esperas = [b for b in r.blocos if any(m["name"] == "text-input-message" for m in b["options"].get("messages", []))]
assert len(esperas) == 6
assert all(b["options"]["nextBlockId"] == r.ack_encerramento["id"] for b in esperas)
assert all(m["options"]["timeoutInSeconds"] == 1800 for b in esperas
           for m in b["options"]["messages"] if m["name"] == "text-input-message")
assert len(g.finalizado("tenant", "instancia", "Teste", "teste", "https://teste.invalid", "chave", nativo=True)["blocks"]) == 2
assert r.blocos[0]["options"]["triggers"][0]["options"]["initializeSession"] == "only-if-finished-service"
assert not any(c["options"].get("parameter") == "[Message-1]text"
               for b in r.blocos for c in b["options"].get("conditions", []))
assert any(c["options"].get("parameter") == "[Message-1]text.body"
           and c["options"].get("equalsTo") == "Atendimento encerrado"
           for b in r.blocos for c in b["options"].get("conditions", []))
print("OK: grafo íntegro; 30 botões; 14 arquivos; ramos duplicados distintos; identidade e canal protegidos")
