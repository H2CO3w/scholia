/-
  Fixture 01 —— 有类型标注的 have（基线形态）

  来源：openai/NavierStokesAndEuler 仓库，AnglePrimitiveKernel.lean（Apache-2.0）
        https://github.com/openai/NavierStokesAndEuler
  裁剪：为回归测试裁成最小片段，have 行保留原文；裁剪后**不保证可编译**。
  期望：每个 have 都有非空签名与非 null 的 typeFingerprint，localName 正确。
-/

theorem fixture_typed_have (P : ℝ) (hP : P ≠ 0) (f : ℝ → E) (hf : Continuous f) (θ : ℝ) :
    primitive P f θ = P⁻¹ • (∫ s in (0 : ℝ)..P, s • f (θ+s)) := by
  let q := primitive P f
  have hq : Continuous q := by
    exact primitive_continuous P f hf
  have hqp : Function.Periodic q P := by
    exact primitive_periodic P f hf hper hmean
  have hzero : (∫ s in (0 : ℝ)..P, q (θ+s))=0 := by
    rw [intervalIntegral.integral_comp_add_left]
    exact primitive_mean_zero P hP f hf
  rw [hzero, zero_add]
