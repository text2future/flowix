import "../../../css/agent-message.css";

interface AgentWelcomeProps {
	onSelectPrompt?: (text: string) => void;
}

const prompts = [
	"Weather app UI",
	"E-commerce checkout",
	"Attendance system",
	"Dark mode dashboard",
	"Responsive nav",
	"Card layout"
];

export function AgentWelcome({ onSelectPrompt }: AgentWelcomeProps) {
	const handleClick = (text: string) => {
		onSelectPrompt?.(text);
	};

	return (
		<div className="agent-welcome w-full">
			<div className="agent-welcome-grid w-full">
				{prompts.map((text, index) => (
					<div
						key={index}
						className="agent-welcome-card"
						onClick={() => handleClick(text)}
					>
						<div className="agent-welcome-prompt">{text}</div>
					</div>
				))}
			</div>
		</div>
	);
}
