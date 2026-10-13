import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

/**
 * Electron-free core (docs/vscode-extension-design.md, "Boundary"): the folders an editor
 * extension reuses through src/core/index.ts. scripts/core-bundle.mjs checks the whole import
 * graph of the entry; this rule flags a forbidden import where it is written.
 */
const CORE_FILES = [
  'src/core/**/*.ts',
  'src/shared/**/*.ts',
  'src/main/db/**/*.ts',
  'src/main/mysql/**/*.ts',
  'src/main/postgres/**/*.ts',
  'src/main/sqlite/**/*.ts',
  'src/main/mongo/**/*.ts',
  'src/main/backup/**/*.ts',
  'src/main/credentials/**/*.ts',
  'src/main/storage/**/*.ts',
  'src/main/ai/**/*.ts',
  'src/main/ipc/{router,errorLog,productionGuard,connections,db,dbPostgres,dbSqlite,mongo,filters,backups,ai,jobValidation}.ts',
  'src/main/migration/mariadbEngine.ts',
  'src/main/{log,env,context,brand}.ts'
]
/** The Electron adapters of the core's ports: desktop-only files inside the core folders. */
const ELECTRON_ADAPTERS = [
  'src/main/sqlite/electronSpawner.ts',
  'src/main/sqlite/worker.ts',
  'src/main/ai/electronFetch.ts',
  'src/main/credentials/electronCodec.ts'
]
const CORE_MESSAGE =
  'The core must stay Electron-free (docs/vscode-extension-design.md): inject a port instead.'

export default tseslint.config(
  { ignores: ['node_modules/**', 'out/**', 'dist/**', 'release/**', 'tests/fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['src/renderer/**/*.{ts,vue}'],
    languageOptions: { globals: { ...globals.browser }, parserOptions: { parser: tseslint.parser } }
  },
  {
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'src/shared/**/*.ts',
      'tests/**/*.ts',
      'scripts/**/*.{ts,mts}',
      '*.ts',
      '*.mjs'
    ],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    files: CORE_FILES,
    ignores: ELECTRON_ADAPTERS,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: CORE_MESSAGE },
            { name: 'electron-updater', message: CORE_MESSAGE }
          ],
          patterns: [
            { regex: '^electron(-updater)?/', message: CORE_MESSAGE },
            {
              regex:
                '(^|/)(electronSpawner|electronCodec|electronFetch|bootstrap|window|menu|screenshots|services)$',
              message: CORE_MESSAGE
            },
            { regex: '(^|/)ipc/typed$|^\\./typed$', message: CORE_MESSAGE },
            { regex: '(^|/)sqlite/worker$|^\\./worker$', message: CORE_MESSAGE },
            { regex: '(^|/)(updates|renderer|preload)(/|$)', message: CORE_MESSAGE }
          ]
        }
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression[source.value=/^electron(-updater)?($|\\u002F)/]',
          message: CORE_MESSAGE
        },
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.value=/^electron(-updater)?($|\\u002F)/]",
          message: CORE_MESSAGE
        },
        // scripts/core-bundle.mjs cannot follow an import whose path is computed at run time.
        {
          selector: "ImportExpression[source.type!='Literal']",
          message:
            'The core boundary check cannot follow a computed import(): use a string literal.'
        },
        {
          selector: "CallExpression[callee.name='require'][arguments.0.type!='Literal']",
          message:
            'The core boundary check cannot follow a computed require(): use a string literal.'
        }
      ]
    }
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      'vue/multi-word-component-names': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off'
    }
  },
  prettier
)
