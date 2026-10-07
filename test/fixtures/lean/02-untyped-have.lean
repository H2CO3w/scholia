/-
  Fixture 02 —— 无类型标注的 have（缺陷 A 回归）

  来源：openai/NavierStokesAndEuler 仓库，AllOrderCorrectionBudget.lean 第 63、77 行
        （Apache-2.0）https://github.com/openai/NavierStokesAndEuler
  裁剪：为回归测试裁成最小片段，have 行保留原文；裁剪后**不保证可编译**。
  期望：`have h := …` / `have hs := …` 的签名为空串、signatureUnknown===true、
        typeFingerprint===null（**不得**是 fingerprint("") 那个常数），rawText 保留逐字原文。
-/

theorem fixture_untyped_have {T : ℝ} (hT : 0 < T) (A : Data period T) (q : ℕ) (hq : 6 ≤ q) :
    ∃ e : C(Icc (0 : ℝ) T, SobolevSpace period (q+1)), True := by
  have h := exists_global_inviscid_gevrey_PDE period hq T hT (A.atOrder period ((q+1)+1))
  rw [A.lower_twice period q] at h
  obtain ⟨e, hi, hd, _, he, hp⟩ := h
  intro t ht
  have hs := hp t ht
  rw [← CorrectionData.source_sobolev] at hs
  exact ⟨e, trivial⟩
