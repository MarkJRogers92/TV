import js from '@eslint/js'; import globals from 'globals'; import tseslint from 'typescript-eslint';
export default [{ignores:['dist/**','dist-server/**','node_modules/**','data/**','.worktrees/**','.superpowers/**']},js.configs.recommended,...tseslint.configs.recommended,{languageOptions:{globals:{...globals.node,...globals.browser}},rules:{'@typescript-eslint/no-explicit-any':'off'}}];
