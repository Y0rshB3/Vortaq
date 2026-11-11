import { describe, expect, it } from 'vitest'
import { firstKeyword, planStatement, statementAt } from './check'
import {
  parseMsShowplan,
  parseMysqlTable,
  parseMysqlTree,
  parsePgPlan,
  parseSqlitePlan
} from './parse'
import { parseXml } from './xml'

const SHOWPLAN = `<?xml version="1.0" encoding="utf-16"?>
<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.564" Build="16.0.1000.6">
  <BatchSequence><Batch><Statements>
    <StmtSimple StatementText="SELECT ..." StatementType="SELECT" StatementSubTreeCost="0.0100" StatementEstRows="3">
      <QueryPlan CachedPlanSize="24">
        <MissingIndexes>
          <MissingIndexGroup Impact="87.5">
            <MissingIndex Database="[tienda]" Schema="[dbo]" Table="[pedidos]">
              <ColumnGroup Usage="EQUALITY"><Column Name="[cliente_id]" ColumnId="2" /></ColumnGroup>
              <ColumnGroup Usage="INCLUDE"><Column Name="[total]" ColumnId="4" /></ColumnGroup>
            </MissingIndex>
          </MissingIndexGroup>
        </MissingIndexes>
        <RelOp NodeId="0" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="3" EstimatedTotalSubtreeCost="0.0100">
          <NestedLoops Optimized="false">
            <RelOp NodeId="1" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="3" EstimatedTotalSubtreeCost="0.0034">
              <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="3" ActualElapsedms="1" /></RunTimeInformation>
              <IndexScan Ordered="false">
                <Object Database="[tienda]" Schema="[dbo]" Table="[pedidos]" Index="[PK_pedidos]" Alias="[p]" />
                <Predicate><ScalarOperator ScalarString="[tienda].[dbo].[pedidos].[estado] as [p].[estado]=N'enviado'" /></Predicate>
              </IndexScan>
            </RelOp>
            <RelOp NodeId="2" PhysicalOp="Clustered Index Seek" LogicalOp="Clustered Index Seek" EstimateRows="1" EstimatedTotalSubtreeCost="0.0066">
              <Warnings><ColumnsWithNoStatistics /></Warnings>
              <IndexScan Ordered="true">
                <Object Database="[tienda]" Schema="[dbo]" Table="[clientes]" Index="[PK_clientes]" Alias="[c]" />
                <SeekPredicates><SeekPredicateNew><SeekKeys><Prefix ScanType="EQ"><RangeColumns /><RangeExpressions><ScalarOperator ScalarString="[tienda].[dbo].[pedidos].[cliente_id] as [p].[cliente_id]" /></RangeExpressions></Prefix></SeekKeys></SeekPredicateNew></SeekPredicates>
              </IndexScan>
            </RelOp>
          </NestedLoops>
        </RelOp>
      </QueryPlan>
    </StmtSimple>
  </Statements></Batch></BatchSequence>
</ShowPlanXML>`

describe('plan parsers', () => {
  it('reads XML: attributes with entities, nesting, namespaces and self-closing tags', () => {
    const doc = parseXml(
      '<?xml version="1.0"?><!-- c --><a:r x="1 &lt; 2 &amp; &#x41;"><b/><c y=\'z\'></c></a:r>'
    )
    expect(doc).toEqual({
      name: 'r',
      attrs: { x: '1 < 2 & A' },
      children: [
        { name: 'b', attrs: {}, children: [] },
        { name: 'c', attrs: { y: 'z' }, children: [] }
      ]
    })
    expect(() => parseXml('<a><b></a>')).toThrow()
  })

  it('SQL Server SHOWPLAN XML: operators, objects, predicates, costs, warnings, missing index', () => {
    const plan = parseMsShowplan(SHOWPLAN, false)
    expect(plan.totalCost).toBe(0.01)
    const { root } = plan
    expect(root.operation).toBe('Nested Loops')
    expect(root.details).toContain('Operación lógica: Inner Join')
    expect(root.children.map((c) => c.operation)).toEqual([
      'Clustered Index Scan',
      'Clustered Index Seek'
    ])
    const [scan, seek] = root.children
    expect(scan.object).toBe('dbo.pedidos p (índice PK_pedidos)')
    expect(scan.details[0]).toMatch(/^Predicado: .*N'enviado'/)
    expect(seek.details[0]).toMatch(/^Búsqueda: .*cliente_id/)
    expect(seek.warnings).toEqual(['Columnas sin estadísticas'])
    expect(scan.costPercent).toBe(34)
    expect(seek.costPercent).toBe(66)
    expect(root.costPercent).toBe(0)
    expect(plan.summary[0]).toBe(
      'Índice recomendado (mejora estimada 88 %): dbo.pedidos (cliente_id) INCLUDE (total)'
    )
    expect(scan.actualRows).toBe(3)
  })

  it('PostgreSQL EXPLAIN (ANALYZE, FORMAT JSON): rows × loops, times, conditions, misestimates', () => {
    const json = JSON.stringify([
      {
        Plan: {
          'Node Type': 'Hash Join',
          'Join Type': 'Inner',
          'Total Cost': 40,
          'Plan Rows': 10,
          'Actual Rows': 2000,
          'Actual Loops': 1,
          'Actual Total Time': 3.5,
          'Hash Cond': '(p.cliente_id = c.id)',
          Plans: [
            {
              'Node Type': 'Seq Scan',
              'Relation Name': 'pedidos',
              Schema: 'public',
              Alias: 'p',
              'Total Cost': 25,
              'Plan Rows': 1000,
              'Actual Rows': 1000,
              'Actual Loops': 1,
              'Actual Total Time': 1.2,
              Filter: "(estado = 'enviado'::text)",
              'Rows Removed by Filter': 50
            },
            {
              'Node Type': 'Index Scan',
              'Relation Name': 'clientes',
              Alias: 'clientes',
              'Index Name': 'clientes_pkey',
              'Total Cost': 5,
              'Plan Rows': 1,
              'Actual Rows': 1,
              'Actual Loops': 3,
              'Actual Total Time': 0.01
            }
          ]
        },
        'Planning Time': 0.2,
        'Execution Time': 3.9
      }
    ])
    const plan = parsePgPlan(json, true)
    expect(plan.root.operation).toBe('Hash Join (Inner)')
    expect(plan.root.details).toEqual(['Condición del hash: (p.cliente_id = c.id)'])
    expect(plan.root.warnings[0]).toMatch(/estimación \(10 filas\).*\(2000\)/)
    const [seq, idx] = plan.root.children
    expect(seq.object).toBe('public.pedidos p')
    expect(seq.details).toEqual([
      "Filtro: (estado = 'enviado'::text)",
      'Filas descartadas por el filtro: 50'
    ])
    expect(idx.object).toBe('clientes (índice clientes_pkey)')
    expect(idx.actualRows).toBe(3)
    expect(idx.actualMs).toBe(0.03)
    expect(plan.summary).toEqual(['Planificación: 0.2 ms', 'Ejecución: 3.9 ms'])
    expect(seq.costPercent).toBe(62.5)
  })

  it('MySQL 8 EXPLAIN FORMAT=TREE and EXPLAIN ANALYZE', () => {
    const tree = [
      '-> Nested loop inner join  (cost=1.20 rows=2) (actual time=0.05..0.08 rows=2 loops=1)',
      "    -> Filter: (c.pais = 'ES')  (cost=0.45 rows=1) (actual time=0.02..0.03 rows=2 loops=1)",
      '        -> Table scan on c  (cost=0.45 rows=3) (actual time=0.01..0.02 rows=3 loops=1)',
      '    -> Index lookup on p using fk_cliente (cliente_id=c.id)  (cost=0.35 rows=1) (actual time=0.01..0.01 rows=1 loops=2)'
    ].join('\n')
    const plan = parseMysqlTree(tree, true)
    expect(plan.root.operation).toBe('Nested loop inner join')
    const [filter, lookup] = plan.root.children
    expect(filter).toMatchObject({ operation: 'Filter', details: ["(c.pais = 'ES')"], estRows: 1 })
    expect(filter.children[0]).toMatchObject({
      operation: 'Table scan',
      object: 'c',
      actualRows: 3
    })
    expect(lookup).toMatchObject({
      operation: 'Index lookup',
      object: 'p (índice fk_cliente)',
      details: ['cliente_id=c.id'],
      actualRows: 2,
      actualMs: 0.02
    })
    expect(plan.totalCost).toBe(1.2)
  })

  it('MySQL 5.7 / MariaDB tabular EXPLAIN (and MariaDB ANALYZE r_rows)', () => {
    const plan = parseMysqlTable(
      [
        {
          id: 1,
          select_type: 'SIMPLE',
          table: 'p',
          type: 'ALL',
          possible_keys: null,
          key: null,
          rows: 5000,
          r_rows: 4800,
          Extra: 'Using where'
        },
        {
          id: 1,
          select_type: 'SIMPLE',
          table: 'c',
          type: 'eq_ref',
          key: 'PRIMARY',
          ref: 'tienda.p.cliente_id',
          rows: 1,
          r_rows: 1
        }
      ],
      'mariadb',
      true
    )
    expect(plan.root.children.map((c) => [c.operation, c.object, c.actualRows])).toEqual([
      ['Recorrido completo de la tabla', 'p', 4800],
      ['Búsqueda única por índice', 'c (índice PRIMARY)', 1]
    ])
    expect(plan.root.children[0].warnings[0]).toMatch(/Lee la tabla entera/)
  })

  it('SQLite EXPLAIN QUERY PLAN rows become a tree', () => {
    const plan = parseSqlitePlan([
      { id: 2, parent: 0, detail: 'SCAN c' },
      { id: 5, parent: 0, detail: 'SEARCH p USING INDEX idx_p_cliente (cliente_id=?)' },
      { id: 9, parent: 0, detail: 'USE TEMP B-TREE FOR ORDER BY' }
    ])
    expect(plan.root.operation).toBe('Consulta')
    expect(plan.root.children.map((c) => [c.operation, c.object])).toEqual([
      ['SCAN (recorrido)', 'c'],
      ['SEARCH (búsqueda)', 'p'],
      ['USE TEMP B-TREE FOR ORDER BY', null]
    ])
    expect(plan.root.children[0].warnings).toEqual(['Recorre toda la tabla'])
  })
})

describe('the statement under the cursor', () => {
  it('picks the statement around the offset, or the last one before it', () => {
    const script = 'SELECT 1;\nSELECT 2 FROM t;\n\nUPDATE t SET a = 1;'
    expect(statementAt('mysql', script, 0).trim()).toBe('SELECT 1')
    expect(statementAt('mysql', script, script.indexOf('2 FROM')).trim()).toMatch(
      /^SELECT 2 FROM t/
    )
    expect(statementAt('mysql', script, script.indexOf('\n\n') + 1).trim()).toMatch(/^SELECT 2/)
    const tsql = 'DECLARE @a int = 1\nSELECT @a AS a\nGO\nSELECT 2'
    expect(statementAt('sqlserver', tsql, tsql.indexOf('@a AS')).trim()).toBe('SELECT @a AS a')
    expect(statementAt('sqlserver', tsql, tsql.length).trim()).toBe('SELECT 2')
  })
})

describe('which statement gets a plan', () => {
  it('one plannable statement; the actual plan only for read-only SELECT', () => {
    expect(firstKeyword('/* x */ -- y\n (SELECT 1)')).toBe('SELECT')
    expect(planStatement('mysql', 'SELECT 1;', false)).toEqual({ statement: 'SELECT 1' })
    expect(planStatement('mysql', 'UPDATE t SET a = 1', false)).toEqual({
      statement: 'UPDATE t SET a = 1'
    })
    expect(planStatement('mysql', 'UPDATE t SET a = 1', true)).toHaveProperty('problem')
    expect(planStatement('postgresql', 'SELECT 1; SELECT 2', false)).toHaveProperty('problem')
    expect(planStatement('postgresql', 'CREATE TABLE t (a int)', false)).toMatchObject({
      problem: expect.stringMatching(/^No hay plan de ejecución para CREATE/)
    })
    expect(planStatement('sqlserver', 'DECLARE @a int = 1\nSELECT @a', false)).toHaveProperty(
      'problem'
    )
    expect(planStatement('sqlserver', 'SELECT * INTO #t FROM dbo.x', true)).toHaveProperty(
      'problem'
    )
    expect(planStatement('sqlite', '  ', false)).toEqual({
      problem: 'No hay ninguna sentencia para analizar.'
    })
  })
})
