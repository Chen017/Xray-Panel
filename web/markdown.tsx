import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import metadata from '../package.json' with {type:'json'};

const repo=`https://github.com/Chen017/Xray-Panel/blob/v${metadata.version}/`;
export function Markdown({source,document='README.md'}:{source:string;document?:string}) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a:({href,children})=>{
      const target=href && !/^(https?:|mailto:|#)/i.test(href) ? new URL(href,repo+document).href : href;
      return <a href={target} target={target?.startsWith('#')?undefined:'_blank'} rel="noopener noreferrer">{children}</a>;
    },
    pre:({children})=><pre tabIndex={0}>{children}</pre>,
    table:({children})=><div className="doc-table"><table>{children}</table></div>
  }}>{source}</ReactMarkdown></div>;
}
