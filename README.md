# SIDP · Form 4 · v2

React + TypeScript, Supabase e GitHub Pages. Interface mínima em português, com o ícone ARCA enviado.

## Fluxo

1. **Dados → Quadro de gestão**: o CSV cria ou atualiza as turmas.
2. **Dados → Lista de presença**: um PDF por upload, vinculado à turma escolhida. Confira os nomes, matrículas, telefones e quem participou; só então confirme a lista.
3. **Dados → Respostas · Form 4**: o CSV/XLSX é cruzado com os participantes de todas as turmas.
4. **Conferência**: confira candidatos e confirme ou ignore os registros ambíguos.
5. **Mensagens**: configure o link do Form 4 e o lembrete de cada turma.
6. **Acessos**: libere as turmas para contas de implementadoras previamente criadas.

As turmas não são fixas nem aparecem como dados fictícios. São geradas pelo `ID_Turma` do quadro de gestão. Não há troca de papéis nem modo de demonstração.

## Instalação

Node.js **22.13+**:

```bash
npm ci
cp .env.example .env.local
```

Configure `.env.local`:

```dotenv
VITE_SUPABASE_URL=https://SEU_PROJETO.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=SUA_CHAVE_PUBLICA
```

Use apenas a chave **publishable / anon**. Chaves `service_role` e `sb_secret_...` nunca podem estar em variáveis `VITE_`, pois o frontend é público.

### Banco novo

Execute no SQL Editor do Supabase, nesta ordem:

1. `supabase/migrations/001_sidp.sql`
2. `supabase/migrations/002_form4_workflow.sql`

Crie sua conta com e-mail e senha em **Authentication → Users**. Verifique a identidade antes de confirmar o e-mail. Depois conceda a administração:

```sql
update public.profiles
set role = 'admin', full_name = 'Equipe MERL ARCA'
where email = lower('SEU_EMAIL');
```

Crie as contas das implementadoras em Authentication → Users. Elas recebem `partner` por padrão. Libere suas turmas na tela **Acessos**. O login é por senha; contas convidadas precisam estabelecer uma senha antes de entrar. Não há cadastro público nem recuperação de senha na interface; esses procedimentos ficam com a administração do Supabase Auth.

### Atualização da v1

Se a primeira migração já foi aplicada, execute **somente `002_form4_workflow.sql`**. Ela preserva contas e dados. Respostas antigas do F4 são copiadas para registros de conferência; seus vínculos precisam ser confirmados pelo novo fluxo. Respostas de outras pesquisas permanecem nas tabelas existentes.

As turmas antigas ficam disponíveis quando seu código é importado pelo quadro de gestão. Confirme os participantes via PDF para habilitar o novo acompanhamento.

### Executar

```bash
npm run dev
```

O comando prepara automaticamente os recursos locais de PDF e OCR. Sem a configuração Supabase, o login permanece indisponível. O ZIP não inclui credenciais nem alunos pré-carregados.

## Quadro de gestão

O parser foi adaptado ao CSV anexado, incluindo colunas finais sem título, notas orientativas e a linha MODELO. Apenas linhas com `ID_Turma` válido geram turmas.

| Campo | Uso |
| --- | --- |
| `ID_Turma` | Código estável da turma |
| `Centro de Treinamento` | Nome exibido no painel |
| `Turno` | Turno |
| `Início da Turma` | Início das aulas |
| `Conclusão da Turma` | Encerramento das aulas |
| `URL Divulgação` | Link, quando contém uma URL HTTPS real |

Datas aceitas: `DD/MM/AAAA` e `AAAA-MM-DD`. Linhas com datas inválidas ou contraditórias impedem o upload. Reimportar atualiza a turma pelo código e preserva participantes, exclusões, acessos e mensagens existentes.

A regra solicitada neste aplicativo é **encerramento + 21 dias corridos**, usando o calendário de Brasília. O banco calcula essa data; não aceita uma data de acompanhamento arbitrária enviada pelo frontend.

No quadro anexado:

| Turma | Aulas | Aplicação do F4 |
| --- | --- | --- |
| T01 | 03/08/2026–07/08/2026 | 28/08/2026 |
| T02 | 31/08/2026–04/09/2026 | 25/09/2026 |

O arquivo contém os textos “Divulgação T01” e “Divulgação T02”, e não as URLs reais. Portanto, os links devem ser preenchidos em **Mensagens**. O aplicativo não inventa URLs.

## Lista de presença em PDF

- Um PDF por upload; pode ter várias páginas, até 25 páginas / 20 MB.
- Selecione uma turma já criada pelo quadro.
- A leitura usa posições das colunas URN, nome, sobrenome e telefone, em vez da ordem interna dos textos do PDF.
- Se não houver uma camada de texto utilizável, o OCR em português é executado no navegador.
- Recursos do OCR, fontes e mapas do PDF são servidos junto com o projeto; o arquivo não é enviado a um serviço externo de OCR.
- Confira a imagem do PDF e edite os campos extraídos. Desmarque quem não participou e adicione linhas que não foram reconhecidas.
- Confirme **“Conferi os dados e a presença dos participantes selecionados”** antes de salvar.

**Assinaturas manuscritas não são prova automática de presença.** Nomes impressos podem incluir faltantes; a confirmação humana na tela é necessária. Se o OCR não reconhecer uma matrícula, a linha pode precisar ser adicionada manualmente. PDFs com outro desenho de tabela também exigem revisão dos campos.

O PDF T01 anexado foi lido como 18 registros. O ZIP de referência contém T02 em DOCX; exporte a lista preenchida dessa turma como PDF para usar no app. O uploader recebe PDF, não ZIP/DOCX.

Uma pessoa sem matrícula pode ser cadastrada para posterior conciliação pelo nome. O identificador interno `SEM-...` não é mostrado como matrícula e não é usado em lembretes. Corrija a matrícula no editor para habilitar o WhatsApp.

O banco armazena as linhas confirmadas, a página e o texto de origem extraído. O binário original do PDF não é arquivado; guarde seu original separado. Reimportar uma lista adiciona/atualiza participantes sem apagar os anteriores. Use **Excluir do acompanhamento** para retirar alguém e preserve suas respostas.

## Form 4 e conciliação

O parser reconhece os campos do CSV real:

| Campo | Uso |
| --- | --- |
| `main_survey/A1_Please_enter_y_stration_Number_URN` | Matrícula |
| `main_survey/A2_Please_enter_your_name` | Nome |
| `main_survey/A3_Country` | País |
| `main_survey/X5_Can_you_provide_our_telephone_number` | Telefone informado |
| `_submission_time` | Data da resposta |
| `_uuid` / `meta/instanceID` / `_id` | Identificador do registro |

Também aceita aliases simples como `matricula`, `nome`, `pais`, `telefone` e `submitted_at`. CSV/TSV/XLSX: primeira aba, até 5.000 linhas / 10 MB. Todas as colunas de respostas são preservadas.

Os valores **Brasil/Brazil** são reconhecidos, incluindo `1__brasil` e `4__brazil`. Registros de outros países ficam no arquivo-fonte armazenado para auditoria, mas não entram na conciliação dos participantes brasileiros. No anexo são 397 linhas: 20 com país Brasil/Brazil e 377 de outros valores. Isso não equivale a 20 participantes válidos; testes, duplicatas e divergências precisam de conferência.

### Correspondência

- Espaços, caixa, acentos e conectivos de nomes são normalizados para comparação; o valor original é preservado.
- Variações de hífens/espaços na matrícula são comparadas sem alterar arbitrariamente seu país/código.
- Uma matrícula equivalente só gera vínculo automático se o nome for compatível.
- Um nome completo equivalente, ou uma abreviação segura de nome do meio, pode gerar vínculo automático quando é único e não há matrícula/telefone contraditório.
- Nomes iguais em turmas diferentes, nomes curtos, erros de matrícula, divergência entre nome e matrícula e correspondências próximas ficam em **A revisar**.
- Telefones válidos ajudam na comparação, mas não substituem a conferência de identidade.
- O percentual exibido nos candidatos é uma pontuação heurística de similaridade, não uma probabilidade estatística.

Respostas em conferência não contam como respondidas. Quando há candidatos para um participante, ele recebe **Em conferência** e seu lembrete fica bloqueado. O admin pode selecionar um candidato ou outro participante ativo, registrar o motivo e confirmar o vínculo. Também pode ignorar testes/registros não pertencentes à turma. O registro original permanece no banco.

Respostas anteriores à janela de 21 dias são sinalizadas. Um vínculo seguro pode aparecer como **Respondeu** com atenção; o aplicativo não invalida nem apaga uma resposta antecipada por conta própria. Use a conferência para decidir o tratamento de cada registro.

Reimportar não desfaz vínculos manuais. Uma mudança na identificação do registro de origem gera atenção. Use **Conciliar novamente** depois de importar outra lista ou corrigir matrículas/nomes.

Várias submissões do mesmo participante contam como uma resposta no painel. Todas ficam em `form4_submissions`; o último registro vinculado por data alimenta a visão atual. Duplicatas recebem uma flag. Se um vínculo for removido ou transferido, o status anterior é recalculado para evitar uma resposta atribuída ao aluno errado.

## Lembretes e implementadoras

O WhatsApp fica habilitado quando:

- já passaram 21 dias do encerramento;
- o participante está ativo e sua presença foi confirmada;
- não há resposta vinculada nem uma resposta em conferência para ele;
- sua matrícula e telefone estão disponíveis;
- o link HTTPS do Form 4 foi configurado.

O botão abre **WhatsApp Web** com número e mensagem preenchidos. A implementadora faz o envio manual. O app não envia mensagens automaticamente nem confirma entrega. Reimporte o dataset do Form 4 para atualizar as respostas.

Placeholders: `{nome}`, `{nome_completo}`, `{turma}`, `{pesquisa}`, `{link}`, `{matricula}`. Telefones brasileiros precisam de DDD; outros países precisam de `+` ou `00` e código de país.

As implementadoras veem somente turmas liberadas, participantes ativos com presença confirmada e status de resposta. Não recebem acesso a respostas completas, fontes ou candidatas de conciliação. O controle é aplicado por RLS no banco.

## GitHub Pages

1. Envie o projeto a um repositório GitHub, branch `main`, incluindo `.github/workflows/deploy.yml`.
2. Em **Settings → Secrets and variables → Actions → Variables**, configure `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY`.
3. Em **Settings → Pages**, escolha **GitHub Actions**.
4. Faça push ou execute manualmente o workflow.
5. Configure a URL publicada em Supabase Auth como site URL.

O workflow instala dependências, testa, prepara recursos locais de OCR/PDF, compila e publica `dist`. O caminho base é derivado da configuração do GitHub Pages. O frontend é estático; os dados e contas ficam no Supabase.

O `dist/` incluso não tem credenciais. Recompile com as duas variáveis para produção. Os diretórios gerados `public/ocr`, `public/pdf-fonts` e `public/pdf-cmaps` são reconstruídos pelos comandos `dev` e `build`.

## Banco e testes

Além das tabelas originais, a v2 acrescenta:

| Tabela | Conteúdo |
| --- | --- |
| `classes` | Datas e origem no quadro de gestão |
| `enrollments` | Presença confirmada, exclusão e atenção |
| `form4_submissions` | Submissões completas, candidatos, flags e revisão |
| `source_imports` | Histórico e datasets de origem |
| `response_status` | Resposta atual por participante/turma e flags |
| `response_answers` | Respostas completas da visão atual, apenas admin |

```bash
npm test
npm run build
```

Os testes executam as migrações em PostgreSQL/PGlite com papéis Auth simulados e verificam permissões, transações, conferência, duplicatas, preservação de dados, nomes, datas, CSV/XLSX e posição das colunas do PDF. A leitura de texto do PDF T01 e dos CSVs anexados foi conferida separadamente. Não houve instalação em um projeto Supabase real, teste de navegador, teste de OCR de ponta a ponta nem publicação.

Não há dados pessoais dos anexos incorporados à aplicação, aos testes ou ao build. A imagem ARCA é o único anexo incluído como recurso visual.

Referências técnicas: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [PDF.js](https://mozilla.github.io/pdf.js/getting_started/), [Tesseract.js](https://github.com/naptha/tesseract.js/blob/master/docs/api.md), [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
