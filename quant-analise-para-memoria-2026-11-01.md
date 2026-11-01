# Registro estratégico Quant — 01/11/2026

**Estado:** evidência histórica em quarentena, NÃO aprovada para negociação automática.

- 18 moedas, 54 combinações de estratégias, 15,533 operações simuladas.
- 0/54 estratégias positivas; perdas somadas de -2446.6331 USDT entre alternativas (não valor de uma carteira).
- 87.12% das saídas por tempo.
- CSV e JSON são representações dos mesmos registros (não duas amostras).
- A estratégia base utiliza filtro de volume >=1,10x, independentemente do 1,50x selecionado para alternativas.
- Stop, alvo e proteção de lucro são simplificações; não usar para ajustar ordens reais antes de auditoria.

## Integração recomendada

Guardar os dois originais imutáveis com hashes SHA256 presentes no registro JSON; adicionar este resumo à memória de pesquisa, com status `QUARANTINED_UNVALIDATED`. Não habilitar autoajuste de entradas/saídas. Corrigir backtester, rodar testes reproduzíveis, comparar resultados em dados futuros e só então considerar regras candidatas sob aprovação.
