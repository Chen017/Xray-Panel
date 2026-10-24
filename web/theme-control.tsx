import {ActionIcon,Menu,Tooltip,useMantineColorScheme} from '@mantine/core';
import {IconCheck,IconDeviceDesktop,IconMoon,IconSun} from '@tabler/icons-react';
import {useState} from 'react';

export function ThemeControl(){
  const {colorScheme,setColorScheme}=useMantineColorScheme();
  const [opened,setOpened]=useState(false);
  const options=[{value:'auto',label:'跟随系统',icon:IconDeviceDesktop},{value:'light',label:'浅色',icon:IconSun},{value:'dark',label:'深色',icon:IconMoon}] as const;
  const current=options.find(option=>option.value===colorScheme)??options[0],Icon=current.icon;
  return <Menu position="bottom-end" shadow="md" width={170} opened={opened} onChange={setOpened}><Menu.Target><Tooltip label={`界面主题：${current.label}`} disabled={opened}><ActionIcon aria-label={`界面主题：${current.label}`} variant="light" color="cyan" size="lg" radius="md"><Icon size={19}/></ActionIcon></Tooltip></Menu.Target><Menu.Dropdown><Menu.Label>界面主题</Menu.Label>{options.map(option=><Menu.Item key={option.value} leftSection={<option.icon size={16}/>} rightSection={colorScheme===option.value?<IconCheck size={15}/>:null} color={colorScheme===option.value?'cyan':undefined} onClick={()=>setColorScheme(option.value)}>{option.label}</Menu.Item>)}</Menu.Dropdown></Menu>;
}
