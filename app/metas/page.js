import MetasView from "./MetasView.jsx";
import IndicadoresView from "../indicadores/IndicadoresView.jsx";

export default function Page() {
  return (
    <>
      <MetasView />
      <hr className="border-white/10 max-w-5xl mx-auto" />
      <IndicadoresView />
    </>
  );
}
