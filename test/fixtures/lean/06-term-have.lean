/-
  Fixture 06 —— 项模式 have（`have h : T := <项>`，值不是 `by` 块）

  来源：openai/NavierStokesAndEuler 仓库，AnglePrimitiveKernel.lean 第 19–20、26–28 行
        （Apache-2.0）https://github.com/openai/NavierStokesAndEuler
  裁剪：为回归测试裁成最小片段；裁剪后**不保证可编译**。
  期望：值是项而不是 `by` 块时，签名照常抽出（非空、指纹非 null），
        且不因为「没有 by」而把它当成未知签名。
-/

theorem fixture_term_have (P : ℝ) (hf : Continuous f) (θ : ℝ) : True := by
  let q := primitive P f
  have hq : Continuous q := primitive_continuous P f hf
  have hqp : Function.Periodic q P := primitive_periodic P f hf hper hmean
  have hqc : Continuous (fun s => q (θ+s)) := hq.comp (continuous_const.add continuous_id)
  have hfc : Continuous (fun s => s • f (θ+s)) :=
    continuous_id.smul (hf.comp (continuous_const.add continuous_id))
  trivial
