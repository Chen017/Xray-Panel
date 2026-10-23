// Adapted from remnawave/frontend src/shared/constants/theme/theme.ts,
// dcb1affbfc42793799caecee988fd20ac0a270b7, AGPL-3.0-only.
import { createTheme } from '@mantine/core';
export const theme=createTheme({cursorType:'pointer',fontFamily:'Inter, "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif',fontFamilyMonospace:'"Cascadia Code", Consolas, monospace',white:'#ffffff',black:'#24292f',colors:{dark:['#c9d1d9','#b1bac4','#8b949e','#6e7681','#484f58','#30363d','#21262d','#161b22','#0d1117','#010409']},primaryShade:6,primaryColor:'cyan',autoContrast:true,luminanceThreshold:0.3,headings:{fontWeight:'600'},defaultRadius:'md',components:{Button:{defaultProps:{fw:500}},TextInput:{defaultProps:{size:'sm'}},Card:{defaultProps:{withBorder:true,padding:'lg'}}}});
