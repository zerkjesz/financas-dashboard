// ============================================================================
// Fase 7.0.3, item 3 — traduz o MESMO contrato Zod (financialIntentPlanSchema.js
// — fonte única de verdade, nunca duplicada por provider, item 5 do pedido)
// pro JSON Schema estrito que o Structured Outputs da Groq exige pra
// `openai/gpt-oss-120b`/`openai/gpt-oss-20b` (auditado em
// https://console.groq.com/docs/structured-outputs, 2026-09):
//
//   - TODA propriedade de todo objeto precisa estar em `required`
//     (mesmo as opcionais no Zod — viram union com null: {"anyOf":[schema,{"type":"null"}]});
//   - TODO objeto precisa de `additionalProperties: false`;
//   - streaming/tool-use não são suportados junto (não usamos nenhum dos dois aqui).
//
// zod-to-json-schema já gera `additionalProperties:false` (zod objects são
// estritos por padrão) mas só marca como `required` os campos que o PRÓPRIO
// Zod schema exige — os `.optional()` ficam de fora do array `required`,
// que é exatamente o que o modo estrito da Groq REJEITA. strictifyForGroq()
// faz só essa correção mecânica, recursivamente, sem reescrever nenhuma
// regra de negócio (a validação de negócio continua 100% no Zod — este
// arquivo só descreve a FORMA pro provider, nunca decide o que é válido).
// ============================================================================
import { zodToJsonSchema } from "zod-to-json-schema";
import { FinancialIntentPlanSchema } from "./financialIntentPlanSchema.js";

// Achado real no smoke contra a API — `partialAction` é um z.record() de
// propósito no contrato Zod (CLARIFICATION_REQUIRED precisa guardar "o que
// já foi entendido com confiança", formato livre — ver financialIntentPlanSchema.js).
// zod-to-json-schema representa isso como {type:"object", additionalProperties:{}}
// (SEM `properties`) — exatamente o formato "objeto de forma livre" que o
// modo estrito da Groq rejeita categoricamente (toda chave precisa ser
// conhecida de antemão). Isto é uma incompatibilidade REAL entre os dois
// mundos, não um bug de tradução — a correção é adaptar só o SCHEMA DE
// TRANSPORTE enviado à Groq (um shape concreto, nullable-tolerant, cobrindo
// os campos reais de uma action parcial), nunca o contrato Zod em si:
// parseAndValidatePlan() continua sendo a única autoridade de validação,
// e ele aceita QUALQUER subconjunto desses campos (um record aceita menos
// chaves do que um shape fixo permite) — nenhuma regra financeira mudou.
const PARTIAL_ACTION_FIELDS = ["type", "amount", "totalAmount", "installments", "installmentAmount", "date", "merchant", "payee", "payer", "category", "description", "account", "card", "paymentMethod"];
const PARTIAL_ACTION_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(
    PARTIAL_ACTION_FIELDS.map((field) => [field, { anyOf: [{ type: field === "installments" ? "integer" : "string" }, { type: "null" }] }])
  ),
  required: [...PARTIAL_ACTION_FIELDS],
  additionalProperties: false,
};

// Acha QUALQUER objeto de forma livre (type:"object" sem `properties` —
// z.record()/z.any()) em QUALQUER profundidade e o substitui por
// PARTIAL_ACTION_SCHEMA. Roda ANTES de strictifyNode/flattenAnyOf, direto no
// output cru do zod-to-json-schema — assim não importa se o campo é
// `.nullish()` (o record aparece dentro de um anyOf com null) ou não: o
// achado real é que o formato exato de aninhamento muda dependendo de como o
// Zod representa opcionalidade, e tentar prever cada variação seria frágil.
// `partialAction` é o único z.record() do contrato hoje (checado no topo do
// arquivo) — se um novo campo desse tipo for adicionado no futuro, ele
// também vira este mesmo shape de transporte (mais seguro que deixar passar
// batido e só descobrir num 400 real).
function substituteFreeFormObjects(node) {
  if (Array.isArray(node)) return node.map(substituteFreeFormObjects);
  if (node && typeof node === "object") {
    if (node.type === "object" && !node.properties && node.additionalProperties !== false && node.additionalProperties !== undefined) {
      return JSON.parse(JSON.stringify(PARTIAL_ACTION_SCHEMA));
    }
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = substituteFreeFormObjects(value);
    return out;
  }
  return node;
}

// Achado real no smoke — depois da migração .optional()->.nullish()
// (financialIntentPlanSchema.js), o zod-to-json-schema já representa
// nullable de VÁRIAS formas diferentes dependendo do tipo Zod por baixo:
// `z.string().nullish()` vira `{"type":["string","null"]}` (sintaxe de
// array em `type`, JSON Schema válido), enquanto `z.union([...]).nullish()`
// vira `{"anyOf":[...,{"type":"null"}]}`. Envolver QUALQUER um dos dois de
// novo em {anyOf:[existing,{type:"null"}]} cria "múltiplos ramos aceitando
// null" — a Groq rejeita com 400 "multiple branches accept null; choose one
// or remove overlap". admitsNull() detecta os dois formatos (e o caso
// degenerado type:"null" puro) pra nunca embrulhar de novo algo que já
// admite null por conta própria.
function admitsNull(schema) {
  if (!schema || typeof schema !== "object") return false;
  if (schema.type === "null") return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some(admitsNull);
  return false;
}

function strictifyNode(node, keyHint) {
  if (Array.isArray(node)) {
    return node.map((item) => strictifyNode(item));
  }
  // Achado real no smoke contra a API — a Groq tenta detectar sozinha qual
  // campo é o "discriminador" do anyOf de 21 actions, e erra com
  // "discriminator: multiple candidate properties confidence, type" porque
  // `confidence` (mesmo enum HIGH/MEDIUM/LOW repetido em TODAS as 21
  // variantes, parte de baseActionFields) parece, pra esse heurístico, um
  // segundo candidato de discriminador tão válido quanto `type` (que É o
  // discriminador real, com um const distinto por variante). A correção é
  // só de TRANSPORTE: solta a restrição de enum de `confidence` pra
  // `{type:"string"}" simples só no schema estrito enviado à Groq — o
  // contrato de verdade (CONFIDENCE_LEVELS = HIGH/MEDIUM/LOW) continua
  // sendo validado por inteiro pelo Zod (parseAndValidatePlan) depois da
  // resposta chegar; se a Groq mandar qualquer coisa fora disso, a
  // validação Zod rejeita e o pipeline falha fechado exatamente como já é
  // testado — nenhuma regra financeira foi enfraquecida.
  if (keyHint === "confidence" && node && typeof node === "object" && node.type === "string" && Array.isArray(node.enum)) {
    return { type: "string" };
  }
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$schema") continue; // metadado do gerador, Groq não usa.
      out[key] = strictifyNode(value, key);
    }

    if (out.type === "object" && out.properties && typeof out.properties === "object") {
      const originalRequired = new Set(Array.isArray(out.required) ? out.required : []);
      const allKeys = Object.keys(out.properties);
      for (const key of allKeys) {
        if (!originalRequired.has(key)) {
          // Campo opcional no Zod -> torna nullable em vez de ausente (é
          // assim que o modo estrito da Groq representa "opcional": union
          // com null, mas SEMPRE presente em `required`).
          //
          // Achado real no smoke contra a API (nunca hipotético): quando o
          // campo já era ele mesmo um z.union() (ex.: `period`), o
          // zod-to-json-schema já produz `{anyOf:[...]}` pra ele — envolver
          // isso de novo em {anyOf:[{anyOf:[...]}, {type:"null"}]} cria um
          // anyOf ANINHADO, que a Groq rejeita com 400 ("variant 0:
          // properties must be present (or set additionalProperties:false)"
          // — cada variante de um anyOf precisa ser um schema concreto, não
          // outro anyOf). Achatar em vez de aninhar: se já é union, `null`
          // vira só mais um membro do MESMO array.
          const existing = out.properties[key];
          if (admitsNull(existing)) {
            // Já aceita null por conta própria (type:["X","null"] ou um anyOf
            // que já inclui {type:"null"}) — embrulhar de novo criaria
            // sobreposição ("multiple branches accept null"), rejeitada pela Groq.
            out.properties[key] = existing;
          } else if (Array.isArray(existing?.anyOf)) {
            out.properties[key] = { anyOf: [...existing.anyOf, { type: "null" }] };
          } else {
            out.properties[key] = { anyOf: [existing, { type: "null" }] };
          }
        }
      }
      out.required = allKeys;
      out.additionalProperties = false;
    }

    return out;
  }
  return node;
}

// Achado real no smoke contra a API — o "achata em vez de aninha" dentro de
// strictifyNode só cobria UM padrão específico de aninhamento (o que a
// PRÓPRIA lógica de opcional->nullable cria). Mas `.nullish()` num campo que
// já é um z.union() (ex.: `period`) faz o zod-to-json-schema PRODUZIR o
// anyOf aninhado sozinho, ANTES até de strictifyNode mexer nele — um padrão
// diferente, que a checagem pontual anterior não pegava. Em vez de tentar
// prever cada combinação possível, esta passada final acha e achata
// QUALQUER anyOf-dentro-de-anyOf, não importa a origem, recursivamente, e
// remove duplicatas de {"type":"null"} que sobrarem do achatamento.
function flattenAnyOf(node) {
  if (Array.isArray(node)) return node.map(flattenAnyOf);
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = flattenAnyOf(value);
    if (Array.isArray(out.anyOf)) {
      const flat = [];
      for (const variant of out.anyOf) {
        if (variant && typeof variant === "object" && Array.isArray(variant.anyOf) && Object.keys(variant).length === 1) {
          flat.push(...variant.anyOf);
        } else {
          flat.push(variant);
        }
      }
      const seen = new Set();
      out.anyOf = flat.filter((variant) => {
        const key = JSON.stringify(variant);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    return out;
  }
  return node;
}

// Auto-checagem estrutural — roda toda vez que o schema é construído (nunca
// silenciosamente confia que a transformação funcionou). Se algum objeto
// escapar sem additionalProperties:false ou com required incompleto, isso é
// EXATAMENTE o tipo de coisa que causaria um 400 real da Groq — falha aqui,
// em vez de descobrir isso só na hora da chamada real.
function assertStrict(node, path = "root") {
  if (Array.isArray(node)) {
    node.forEach((item, i) => assertStrict(item, `${path}[${i}]`));
    return;
  }
  if (node && typeof node === "object") {
    if (node.type === "object" && node.properties) {
      if (node.additionalProperties !== false) {
        throw new Error(`groqStrictSchema: ${path} não tem additionalProperties:false`);
      }
      const propKeys = Object.keys(node.properties).sort();
      const reqKeys = [...(node.required || [])].sort();
      if (JSON.stringify(propKeys) !== JSON.stringify(reqKeys)) {
        throw new Error(`groqStrictSchema: ${path}.required (${reqKeys.join(",")}) não bate com properties (${propKeys.join(",")})`);
      }
    }
    // Achado real no smoke — um objeto "de forma livre" (type:"object" sem
    // `properties`, ex.: originado de z.record()) nunca é aceito pelo modo
    // estrito da Groq, mesmo com additionalProperties:false (não tem o que
    // ser falso — não há chave nenhuma pra descrever). Se algum campo novo
    // no contrato Zod virar isso no futuro, falha aqui explicitamente em vez
    // de só na chamada real.
    if (node.type === "object" && !node.properties) {
      throw new Error(`groqStrictSchema: ${path} é um objeto de forma livre (sem \`properties\` — provavelmente um z.record()/z.any() no contrato) — a Groq strict mode nunca aceita isso; precisa de um shape concreto de transporte (ver PARTIAL_ACTION_SCHEMA como exemplo)`);
    }
    // Achado real no smoke contra a API — a Groq rejeita anyOf aninhado
    // (uma variante que é ela mesma só {anyOf:[...]}, sem type/properties
    // próprios). Nunca mais confiar só na inspeção visual: falha aqui antes
    // de qualquer chamada real.
    if (Array.isArray(node.anyOf)) {
      node.anyOf.forEach((variant, i) => {
        if (variant && typeof variant === "object" && Array.isArray(variant.anyOf)) {
          throw new Error(`groqStrictSchema: ${path}.anyOf[${i}] é um anyOf aninhado dentro de outro anyOf — a Groq rejeita isso (achata em vez de aninhar)`);
        }
      });
    }
    for (const [key, value] of Object.entries(node)) {
      assertStrict(value, `${path}.${key}`);
    }
  }
}

// Achado real no smoke contra a API — o schema estrito completo (todo campo
// required+nullable em todo objeto) facilmente passa de 6500 tokens sozinho,
// e o free tier da Groq pro model candidato tem só 8000 tokens/min (TPM,
// console.groq.com/docs/rate-limits). `referencesToPreviousMessage` é um
// objeto de 4 campos IDÊNTICO repetido em TODAS as ~19 variantes que herdam
// baseActionFields — de longe o maior desperdício por repetição. Em vez de
// arriscar mudar a estratégia de $ref do zod-to-json-schema inteira (que
// pode introduzir padrões de $ref não testados em outros lugares do
// schema), extrai só ESTE objeto pra `definitions` manualmente (chave do
// draft-07, o mesmo `target` usado abaixo — `$defs` é de um draft mais novo)
// e substitui cada ocorrência por `{"$ref":"#/definitions/referencesToPreviousMessage"}`
// — a Groq documenta suporte a $ref pra estruturas aninhadas em Structured
// Outputs (console.groq.com/docs/structured-outputs). Reduz o schema em ~20%.
function deduplicateReferencesToPreviousMessage(schema) {
  let sharedDef = null;
  function walk(node) {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "referencesToPreviousMessage" && value && typeof value === "object" && Array.isArray(value.anyOf)) {
          const objectVariant = value.anyOf.find((v) => v && v.type === "object");
          if (objectVariant) {
            if (!sharedDef) sharedDef = JSON.parse(JSON.stringify(objectVariant));
            node[key] = { anyOf: [{ $ref: "#/definitions/referencesToPreviousMessage" }, { type: "null" }] };
            continue;
          }
        }
        walk(value);
      }
    }
  }
  walk(schema);
  if (sharedDef) {
    schema.definitions = { referencesToPreviousMessage: sharedDef };
  }
  return schema;
}

let cachedSchema = null;

// Exportada pra permitir teste/inspeção sem gastar uma chamada real — o
// mesmo objeto que vai dentro de response_format.json_schema.schema.
export function buildGroqStrictSchema() {
  if (cachedSchema) return cachedSchema;
  const raw = zodToJsonSchema(FinancialIntentPlanSchema, { $refStrategy: "none", target: "jsonSchema7" });
  const strict = flattenAnyOf(strictifyNode(substituteFreeFormObjects(raw)));
  const deduped = deduplicateReferencesToPreviousMessage(strict);
  assertStrict(deduped);
  cachedSchema = deduped;
  return deduped;
}

export function buildGroqResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "financial_intent_plan",
      strict: true,
      schema: buildGroqStrictSchema(),
    },
  };
}
